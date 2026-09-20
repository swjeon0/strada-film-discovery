#!/usr/bin/env python3
"""Import cached offline vectors into active, versioned SQLite observations; no network."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]


def embedding_input(observation: dict) -> str:
    """Exactly matches embeddingRows() in embed-knowledge.ts; no normalization."""
    return "\n".join([observation["summary"], observation.get("summaryKo") or "", *observation["subjects"], f"Scope: {observation['boundary']}"])


def input_hash(model: str, dimensions: int, text: str) -> str:
    return hashlib.sha256(f"{model}:{dimensions}:{text}".encode("utf-8")).hexdigest()


def import_embeddings(index_path: Path, cache_path: Path, db_path: Path) -> dict:
    if not db_path.is_file():
        raise ValueError("Knowledge SQLite database is missing; run build-knowledge.py first")
    index = json.loads(index_path.read_text())
    cache = json.loads(cache_path.read_text())
    if index.get("version") != 1 or not index.get("corpusVersion"):
        raise ValueError("Invalid serving index")
    model, dimensions = cache.get("model"), cache.get("dimensions")
    if not isinstance(model, str) or not model or type(dimensions) is not int or not 1 <= dimensions <= 16384:
        raise ValueError("Invalid cache model/dimensions")
    if not isinstance(cache.get("vectors"), dict):
        raise ValueError("Cache vectors must be keyed by exact input hashes")
    generated = cache.get("generatedAt", {})
    if not isinstance(generated, dict):
        raise ValueError("Cache generatedAt must be a per-hash timestamp map")
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    if not db.execute("PRAGMA table_info(observation_embeddings)").fetchall():
        db.close()
        raise ValueError("Embedding schema is missing; run build-knowledge.py first")
    # Upgrade pre-import pilot databases without rewriting historical vectors.
    if "imported_at" not in {row["name"] for row in db.execute("PRAGMA table_info(observation_embeddings)")}:
        db.execute("ALTER TABLE observation_embeddings ADD COLUMN imported_at TEXT")
        db.commit()
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    inserted = reused = 0
    hashes: set[str] = set()
    try:
        with db:
            active_versions = {row["id"]: row["current_version_id"] for row in db.execute("SELECT id,current_version_id FROM sources WHERE current_version_id IS NOT NULL")}
            requested_versions = {document["id"]: document["versionId"] for document in index["documents"]}
            if len(requested_versions) != len(index["documents"]) or requested_versions != active_versions:
                raise ValueError("Serving corpus membership is not the active SQLite version set; rebuild the index/database together")
            for document in index["documents"]:
                if document["type"] == "academic" and document["access"] != "full_page":
                    raise ValueError(f"Academic source has no admitted full text: {document['id']}")
                version = db.execute("SELECT v.id,v.content_hash FROM sources s JOIN document_versions v ON v.id=s.current_version_id WHERE s.id=?", (document["id"],)).fetchone()
                if not version or version["id"] != document["versionId"] or version["content_hash"] != document["contentHash"]:
                    raise ValueError(f"Serving document is not the active SQLite version: {document['id']}")
                for observation in document["observations"]:
                    if observation["kind"] == "incidental_mention":
                        continue
                    observation_id = f"{document['versionId']}/{observation['id']}"
                    row = db.execute("SELECT * FROM observations WHERE id=? AND version_id=?", (observation_id, document["versionId"])).fetchone()
                    if not row:
                        raise ValueError(f"Missing versioned observation: {observation_id}")
                    persisted = {"summary": row["summary"], "summaryKo": row["summary_ko"], "subjects": json.loads(row["subjects_json"]), "boundary": row["boundary"]}
                    text = embedding_input(observation)
                    if text != embedding_input(persisted) or observation["kind"] != row["kind"]:
                        raise ValueError(f"Embedding input differs from persisted observation: {observation_id}")
                    hashed = input_hash(model, dimensions, text)
                    vector = cache["vectors"].get(hashed)
                    if not isinstance(vector, list) or len(vector) != dimensions or any(type(value) not in (int, float) or not math.isfinite(value) for value in vector):
                        raise ValueError(f"Missing or invalid cached embedding: {document['id']}:{observation['id']}")
                    generated_at = generated.get(hashed, "unknown_legacy_cache")
                    if generated_at != "unknown_legacy_cache":
                        try:
                            datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
                        except (AttributeError, ValueError) as exc:
                            raise ValueError("Invalid cached embedding generation timestamp") from exc
                    existing = db.execute("SELECT embedding_json FROM observation_embeddings WHERE observation_id=? AND model=? AND dimensions=? AND input_hash=?", (observation_id, model, dimensions, hashed)).fetchone()
                    if existing:
                        if json.loads(existing["embedding_json"]) != vector:
                            raise ValueError(f"Cached vector conflicts with immutable imported vector: {observation_id}")
                        reused += 1
                    else:
                        db.execute("INSERT INTO observation_embeddings (observation_id,model,dimensions,input_hash,embedding_json,generated_at,imported_at) VALUES (?,?,?,?,?,?,?)", (observation_id, model, dimensions, hashed, json.dumps(vector, separators=(",", ":")), generated_at, timestamp))
                        inserted += 1
                    hashes.add(hashed)
            active_count = db.execute("SELECT count(*) FROM observation_embeddings e JOIN observations o ON o.id=e.observation_id JOIN sources s ON s.current_version_id=o.version_id WHERE e.model=? AND e.dimensions=?", (model, dimensions)).fetchone()[0]
            total_count = db.execute("SELECT count(*) FROM observation_embeddings").fetchone()[0]
            foreign_keys = list(db.execute("PRAGMA foreign_key_check"))
            if foreign_keys:
                raise ValueError("Embedding import failed database foreign-key validation")
    finally:
        db.close()
    return {"corpusVersion": index["corpusVersion"], "model": model, "dimensions": dimensions, "inserted": inserted, "reused": reused, "activeObservationEmbeddings": active_count, "totalHistoricalEmbeddings": total_count, "distinctInputHashes": len(hashes), "networkCalls": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=ROOT / "research/knowledge/serving-index.json")
    parser.add_argument("--cache", type=Path, default=ROOT / "work/knowledge/embeddings.json")
    parser.add_argument("--db", type=Path, default=ROOT / "work/knowledge/corpus.sqlite")
    args = parser.parse_args()
    try:
        result = import_embeddings(args.index, args.cache, args.db)
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as exc:
        print(f"Embedding import failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
