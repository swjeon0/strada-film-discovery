#!/usr/bin/env python3
"""Offline, resumable corpus ingestion. No fetching, APIs, or inferred permissions."""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import unicodedata
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PARSER_VERSION = "strada-record-v1.2-full-text-academic"
SOURCE_TYPES = {"criticism", "academic", "programme", "festival"}
ACCESS = {"full_page", "abstract", "metadata_only"}
RIGHTS = {"restricted_excerpt", "open_license", "noncommercial", "metadata_only"}
KINDS = {"film_reading", "comparison", "contrast", "influence", "co_programming", "historical_context", "incidental_mention"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encoded(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: object) -> str:
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).casefold()
    return "".join(c for c in value if c.isalnum() and not unicodedata.combining(c))


def required_text(obj: dict, key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key}: expected nonempty text")
    return value


def require_url(value: object, field: str) -> None:
    parsed = urlsplit(value if isinstance(value, str) else "")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError(f"{field}: expected a public http(s) URL without credentials")


def string_list(obj: dict, key: str, nonempty: bool = False) -> list[str]:
    values = obj.get(key)
    if not isinstance(values, list) or any(not isinstance(v, str) or not v.strip() for v in values):
        raise ValueError(f"{key}: expected an array of nonempty strings")
    if nonempty and not values:
        raise ValueError(f"{key}: must not be empty")
    if len(set(values)) != len(values):
        raise ValueError(f"{key}: duplicate references")
    return values


def words(value: str) -> int:
    return len(re.findall(r"\S+", value))


def content_hash(record: dict) -> str:
    content = copy.deepcopy(record)
    # Rechecking an identical document records a review, not a new content version.
    content.pop("checkedAt", None)
    return digest(content)


def validate_record(record: object) -> dict:
    if not isinstance(record, dict):
        raise ValueError("record must be an object")
    record = copy.deepcopy(record)
    source_id = required_text(record, "id")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,159}", source_id):
        raise ValueError("id must be a stable lowercase slug (3-160 characters)")
    for key in ("title", "publisher", "language", "checkedAt"):
        required_text(record, key)
    require_url(record.get("url"), "url")
    if record.get("author") is not None and not isinstance(record["author"], str):
        raise ValueError("author must be text or null")
    try:
        datetime.fromisoformat(record["checkedAt"].replace("Z", "+00:00"))
        if record.get("publishedAt") is not None:
            published = record["publishedAt"]
            if re.fullmatch(r"\d{4}", published):
                datetime.strptime(published, "%Y")
            elif re.fullmatch(r"\d{4}-\d{2}", published):
                datetime.strptime(published, "%Y-%m")
            else:
                datetime.fromisoformat(published.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("checkedAt/publishedAt must be valid ISO dates") from exc
    if record.get("type") not in SOURCE_TYPES or record.get("access") not in ACCESS:
        raise ValueError("unsupported source type or access")
    if record["type"] == "academic" and record["access"] != "full_page":
        raise ValueError("academic admission requires accessed full text (access=full_page); abstracts and metadata-only sources are excluded")
    rights = record.get("rights", {})
    if not isinstance(rights, dict) or rights.get("mode") not in RIGHTS:
        raise ValueError("rights.mode is required and must be explicit")
    required_text(rights, "note")
    if rights.get("licenseUrl") is not None:
        require_url(rights["licenseUrl"], "rights.licenseUrl")
    if rights["mode"] in {"open_license", "noncommercial"} and not rights.get("licenseUrl"):
        raise ValueError("licensed content requires an explicit license URL")
    verification = record.get("verification", {})
    if not isinstance(verification, dict) or verification.get("method") not in {"web_open", "http_fetch"}:
        raise ValueError("verification.method must describe actual access")
    for key in ("locator", "note"):
        required_text(verification, key)
    if verification.get("textUrl") is not None:
        require_url(verification["textUrl"], "verification.textUrl")
    if record.get("reviewStatus") not in {None, "agent_reviewed"}:
        raise ValueError("ingestion cannot assert human review")
    films = record.get("films")
    passages = record.get("passages")
    observations = record.get("observations")
    if not isinstance(films, list) or not films:
        raise ValueError("films must not be empty")
    if not isinstance(passages, list) or not isinstance(observations, list):
        raise ValueError("passages and observations must be arrays")
    if record["access"] != "metadata_only" and (not passages or not observations):
        raise ValueError("accessible documents require a quote and observation")
    if record["access"] == "metadata_only" and (passages or observations):
        raise ValueError("metadata-only sources cannot claim textual evidence")
    film_keys: set[str] = set()
    identities: dict[str, tuple[int, str]] = {}
    for film in films:
        if not isinstance(film, dict):
            raise ValueError("film must be an object")
        for key in ("key", "title", "director"):
            required_text(film, key)
        if film["key"] in film_keys:
            raise ValueError("duplicate film key")
        film_keys.add(film["key"])
        if type(film.get("year")) is not int or not 1870 <= film["year"] <= datetime.now().year + 2:
            raise ValueError(f"impossible film year: {film.get('year')}")
        aliases = string_list(film, "aliases")
        if not isinstance(film.get("externalIds"), list):
            raise ValueError("externalIds must be an array")
        for external in film["externalIds"]:
            if not isinstance(external, dict) or not external.get("provider") or not external.get("id"):
                raise ValueError("externalIds entries require provider and id")
        for title in [film["title"], *aliases]:
            alias_key = normalize(title)
            identity = (film["year"], normalize(film["director"]))
            if alias_key in identities and identities[alias_key] != identity:
                # A document can discuss remakes, but not assign the same explicit key to them.
                continue
            identities[alias_key] = identity
    passage_ids: set[str] = set()
    total_quote_words = 0
    for passage in passages:
        if not isinstance(passage, dict):
            raise ValueError("passage must be an object")
        for key in ("id", "text", "locator"):
            required_text(passage, key)
        if passage["id"] in passage_ids:
            raise ValueError("duplicate passage id")
        passage_ids.add(passage["id"])
        total_quote_words += words(passage["text"])
    if total_quote_words > 25:
        raise ValueError(f"document quotes total {total_quote_words} words; maximum is 25")
    observation_ids: set[str] = set()
    prose_words = 0
    for observation in observations:
        if not isinstance(observation, dict):
            raise ValueError("observation must be an object")
        for key in ("id", "summary", "boundary"):
            required_text(observation, key)
        if observation["id"] in observation_ids:
            raise ValueError("duplicate observation id")
        observation_ids.add(observation["id"])
        if observation.get("summaryKo") is not None and not isinstance(observation["summaryKo"], str):
            raise ValueError("summaryKo must be text or null")
        if observation.get("kind") not in KINDS:
            raise ValueError("unsupported observation kind")
        participants = string_list(observation, "filmKeys", nonempty=True)
        anchors = string_list(observation, "passageIds", nonempty=True)
        string_list(observation, "subjects", nonempty=True)
        if not set(participants) <= film_keys or not set(anchors) <= passage_ids:
            raise ValueError("observation has missing film or passage references")
        if observation["kind"] in {"comparison", "contrast", "influence", "co_programming"} and len(participants) < 2:
            raise ValueError("relational observation requires at least two participants")
        prose_words += sum(words(observation.get(k) or "") for k in ("summary", "summaryKo", "boundary"))
    if prose_words > 160:
        raise ValueError(f"derived prose totals {prose_words} words; maximum is 160")
    return record


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript((ROOT / "research/knowledge/schema.sql").read_text())
    return db


def resolve_film(db: sqlite3.Connection, film: dict, timestamp: str) -> str:
    director = normalize(film["director"])
    year = film["year"]
    title_forms = {normalize(v) for v in [film["title"], *film["aliases"]]}
    matches: set[str] = set()
    for value in title_forms:
        rows = db.execute("SELECT film_key FROM aliases WHERE alias_normalized=? AND year=? AND director_normalized=? AND alias_type='title'", (value, year, director))
        matches.update(row[0] for row in rows)
    # Original source keys may recur across records. Contradictory identities are quarantined.
    prior_keys = db.execute("SELECT a.film_key,f.year,f.director_normalized FROM aliases a JOIN film_entities f ON f.key=a.film_key WHERE a.alias_type='record_key' AND a.alias_normalized=?", (normalize(film["key"]),)).fetchall()
    for prior in prior_keys:
        if prior["year"] != year or prior["director_normalized"] != director:
            raise ValueError(f"inconsistent identity metadata for film key {film['key']}")
        known_titles = {r[0] for r in db.execute("SELECT alias_normalized FROM aliases WHERE film_key=? AND alias_type='title'", (prior["film_key"],))}
        if not title_forms.intersection(known_titles):
            raise ValueError(f"inconsistent title metadata for film key {film['key']}; document an actual shared alias")
        matches.add(prior["film_key"])
    if len(matches) > 1:
        raise ValueError(f"ambiguous film aliases require explicit reconciliation: {film['title']}")
    if matches:
        key = next(iter(matches))
    else:
        key = "film-" + digest([normalize(film["title"]), year, director])[:24]
        db.execute("INSERT OR IGNORE INTO film_entities VALUES (?,?,?,?,?,?,?,?)", (key, film["title"], normalize(film["title"]), year, film["director"], director, encoded(film["externalIds"]), timestamp))
    current = json.loads(db.execute("SELECT external_ids_json FROM film_entities WHERE key=?", (key,)).fetchone()[0])
    external_ids = {str(v["provider"]): str(v["id"]) for v in current}
    for external in film["externalIds"]:
        provider, value = str(external["provider"]), str(external["id"])
        if provider in external_ids and external_ids[provider] != value:
            raise ValueError(f"conflicting external ID for {film['title']}: {provider}")
        external_ids[provider] = value
    db.execute("UPDATE film_entities SET external_ids_json=? WHERE key=?", (encoded([{"provider": p, "id": v} for p, v in sorted(external_ids.items())]), key))
    for alias_type, values in (("title", [film["title"], *film["aliases"]]), ("record_key", [film["key"]])):
        for alias in values:
            db.execute("INSERT OR IGNORE INTO aliases VALUES (?,?,?,?,?,?)", (key, alias, normalize(alias), alias_type, year, director))
    return key


def seed_identity_registry(db: sqlite3.Connection, registry: Path) -> None:
    if not registry.exists():
        return
    content = json.loads(registry.read_text())
    if content.get("version") != 1 or not isinstance(content.get("films"), list):
        raise ValueError("invalid film identity registry")
    timestamp = now()
    with db:
        for film in content["films"]:
            director = normalize(film["director"])
            existing = db.execute("SELECT title_normalized,year,director_normalized FROM film_entities WHERE key=?", (film["key"],)).fetchone()
            if existing and (existing["year"] != film["year"] or existing["director_normalized"] != director):
                raise ValueError("identity registry conflicts with existing database")
            db.execute("INSERT OR IGNORE INTO film_entities VALUES (?,?,?,?,?,?,?,?)", (film["key"], film["title"], normalize(film["title"]), film["year"], film["director"], director, encoded(film["externalIds"]), timestamp))
            for alias_type, aliases in (("title", [film["title"], *film["aliases"]]), ("record_key", film.get("sourceKeys", []))):
                for alias in aliases:
                    prior = db.execute("SELECT film_key FROM aliases WHERE alias_normalized=? AND year=? AND director_normalized=? AND alias_type=?", (normalize(alias), film["year"], director, alias_type)).fetchone()
                    if prior and prior[0] != film["key"]:
                        raise ValueError("identity registry contains ambiguous aliases")
                    db.execute("INSERT OR IGNORE INTO aliases VALUES (?,?,?,?,?,?)", (film["key"], alias, normalize(alias), alias_type, film["year"], director))


def write_identity_registry(db: sqlite3.Connection, registry: Path) -> None:
    films = []
    for row in db.execute("SELECT * FROM film_entities ORDER BY key"):
        title_aliases = [r[0] for r in db.execute("SELECT alias FROM aliases WHERE film_key=? AND alias_type='title' ORDER BY alias_normalized", (row["key"],)) if r[0] != row["title"]]
        source_keys = [r[0] for r in db.execute("SELECT alias FROM aliases WHERE film_key=? AND alias_type='record_key' ORDER BY alias_normalized", (row["key"],))]
        films.append({"key": row["key"], "title": row["title"], "year": row["year"], "director": row["director"], "aliases": title_aliases, "externalIds": json.loads(row["external_ids_json"]), "sourceKeys": source_keys})
    registry.parent.mkdir(parents=True, exist_ok=True)
    temporary = registry.with_suffix(".json.tmp")
    temporary.write_text(json.dumps({"version": 1, "films": films}, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(registry)


def import_record(db: sqlite3.Connection, record: dict, timestamp: str) -> str:
    source_id = record["id"]
    source = db.execute("SELECT canonical_url FROM sources WHERE id=?", (source_id,)).fetchone()
    if source and source["canonical_url"] != record["url"]:
        raise ValueError("source id changed canonical URL; use an explicit migration")
    db.execute("INSERT OR IGNORE INTO sources VALUES (?,?,NULL,?,?)", (source_id, record["url"], timestamp, timestamp))
    hashed = content_hash(record)
    version_id = f"{source_id}@{hashed}"
    exists = db.execute("SELECT id FROM document_versions WHERE id=?", (version_id,)).fetchone()
    if not exists:
        rights, verification = record["rights"], record["verification"]
        db.execute("INSERT INTO document_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            version_id, source_id, hashed, record["title"], record.get("author"), record["publisher"], record["type"], record["language"], record.get("publishedAt"), record["checkedAt"], record["access"], rights["mode"], rights.get("licenseUrl"), rights["note"], verification["method"], verification["locator"], verification["note"], "agent_reviewed", encoded(record), PARSER_VERSION, timestamp,
        ))
        mapping = {film["key"]: resolve_film(db, film, timestamp) for film in record["films"]}
        if len(set(mapping.values())) != len(mapping):
            raise ValueError("duplicate canonical film identity within document; use one film and title aliases")
        for index, film in enumerate(record["films"]):
            db.execute("INSERT INTO document_films VALUES (?,?,?,?)", (version_id, mapping[film["key"]], film["key"], index))
        for index, passage in enumerate(record["passages"]):
            db.execute("INSERT INTO passages (id,version_id,local_id,ordinal,exact_quote,locator,text_hash) VALUES (?,?,?,?,?,?,?)", (f"{version_id}/{passage['id']}", version_id, passage["id"], index, passage["text"], passage["locator"], digest(passage["text"])))
        for observation in record["observations"]:
            oid = f"{version_id}/{observation['id']}"
            db.execute("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)", (oid, version_id, observation["id"], observation["summary"], observation.get("summaryKo"), observation["boundary"], observation["kind"], encoded(observation["subjects"]), "agent_reviewed"))
            for index, source_key in enumerate(observation["filmKeys"]):
                db.execute("INSERT OR IGNORE INTO observation_participants VALUES (?,?,?)", (oid, mapping[source_key], index))
            for pid in observation["passageIds"]:
                db.execute("INSERT INTO evidence_links (observation_id,passage_id) VALUES (?,?)", (oid, f"{version_id}/{pid}"))
    db.execute("UPDATE sources SET current_version_id=?,updated_at=? WHERE id=?", (version_id, timestamp, source_id))
    review_id = digest([version_id, "source-record-agent", record["checkedAt"]])
    db.execute("INSERT OR IGNORE INTO review_events VALUES (?,?,?,?,?,?,?)", (review_id, version_id, "agent", "source-record-agent", "agent_reviewed", "Source record reports original-page access. Offline ingestion validates structure; it does not independently verify network content or claim human approval.", record["checkedAt"]))
    return version_id


def export_document(db: sqlite3.Connection, version_id: str) -> dict:
    row = db.execute("SELECT * FROM document_versions WHERE id=?", (version_id,)).fetchone()
    record = json.loads(row["original_record_json"])
    mappings = {r["source_key"]: r["film_key"] for r in db.execute("SELECT * FROM document_films WHERE version_id=? ORDER BY ordinal", (version_id,))}
    record.update({"versionId": version_id, "contentHash": row["content_hash"], "reviewStatus": "agent_reviewed", "keyMappings": mappings})
    for film in record["films"]:
        film["sourceKey"] = film["key"]
        film["key"] = mappings[film["key"]]
    for observation in record["observations"]:
        observation["filmKeys"] = list(dict.fromkeys(mappings[key] for key in observation["filmKeys"]))
    return record


def export_index(db: sqlite3.Connection, version_ids: list[str], output: Path, commercial_only: bool) -> dict:
    documents = [export_document(db, value) for value in sorted(set(version_ids))]
    # An independent publication guard also applies to pre-policy historical versions.
    documents = [record for record in documents if record["type"] != "academic" or record["access"] == "full_page"]
    version_ids = [record["versionId"] for record in documents]
    keys = sorted({film["key"] for record in documents for film in record["films"]})
    films = []
    for key in keys:
        row = db.execute("SELECT * FROM film_entities WHERE key=?", (key,)).fetchone()
        aliases = [r[0] for r in db.execute("SELECT alias FROM aliases WHERE film_key=? AND alias_type='title' ORDER BY alias_normalized", (key,)) if r[0] != row["title"]]
        films.append({"key": key, "title": row["title"], "year": row["year"], "director": row["director"], "aliases": aliases, "externalIds": json.loads(row["external_ids_json"])})
    stats = {"documents": len(documents), "versions": len(documents), "films": len(films), "passages": sum(len(r["passages"]) for r in documents), "observations": sum(len(r["observations"]) for r in documents), "evidenceLinks": sum(len(o["passageIds"]) for r in documents for o in r["observations"]), "agentReviewed": len(documents), "humanApproved": 0, "commercialOnly": commercial_only,
             "byType": {kind: sum(r["type"] == kind for r in documents) for kind in sorted(SOURCE_TYPES)},
             "byRights": {mode: sum(r["rights"]["mode"] == mode for r in documents) for mode in sorted(RIGHTS)},
             "quoteVerification": "agent_source_access_reported; offline_quote_match_not_performed"}
    corpus_version = digest({"parser": PARSER_VERSION, "versions": sorted(set(version_ids)), "films": films, "commercialOnly": commercial_only})
    built_at = now()
    if output.exists():
        previous = json.loads(output.read_text())
        if previous.get("corpusVersion") == corpus_version:
            built_at = previous["builtAt"]
    result = {"version": 1, "corpusVersion": corpus_version, "builtAt": built_at, "documents": documents, "films": films, "stats": stats}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(output)
    return result


def build(input_path: Path, db_path: Path, output: Path, commercial_only: bool = False, registry: Path | None = None) -> dict:
    files = sorted(input_path.glob("*.json")) if input_path.is_dir() else [input_path]
    if not files:
        raise ValueError(f"no JSON records found: {input_path}")
    db = connect(db_path)
    registry = registry or output.with_name("film-identity-registry.json")
    seed_identity_registry(db, registry)
    active_versions: list[str] = []
    audit: list[dict] = []
    seen_ids: set[str] = set()
    mode = "commercial" if commercial_only else "research"
    timestamp = now()
    for file in files:
        raw = file.read_bytes()
        file_hash = hashlib.sha256(raw).hexdigest()
        job_id = digest([str(file.resolve()), file_hash, mode, PARSER_VERSION])
        with db:
            db.execute("INSERT OR IGNORE INTO ingestion_jobs VALUES (?,?,?,?,?,'running',0,?,?)", (job_id, str(file.resolve()), file_hash, mode, PARSER_VERSION, timestamp, timestamp))
        try:
            records = json.loads(raw)
            if not isinstance(records, list):
                raise ValueError("each record file must contain a JSON array")
        except (ValueError, UnicodeDecodeError) as exc:
            records = [{"__fileParseError": str(exc)}]
        file_errors = 0
        for index, candidate in enumerate(records):
            record_id = candidate.get("id") if isinstance(candidate, dict) else None
            record_hash = digest(candidate)
            try:
                if record_id and record_id in seen_ids:
                    raise ValueError("duplicate source id across input records")
                if record_id:
                    seen_ids.add(record_id)
                if isinstance(candidate, dict) and "__fileParseError" in candidate:
                    raise ValueError(candidate["__fileParseError"])
                # Admission is rechecked before a persisted checkpoint can be resumed.
                record = validate_record(candidate)
                prior = db.execute("SELECT status,version_id,error FROM ingestion_items WHERE job_id=? AND item_index=?", (job_id, index)).fetchone()
                if prior:
                    if prior["status"] == "completed":
                        active_versions.append(prior["version_id"])
                        with db:
                            db.execute("UPDATE sources SET current_version_id=?,updated_at=? WHERE id=?", (prior["version_id"], timestamp, record_id))
                    if prior["status"] == "quarantined":
                        file_errors += 1
                    audit.append({"id": record_id, "status": prior["status"], "versionId": prior["version_id"], "resumed": True, "error": prior["error"]})
                    continue
                if commercial_only and record["rights"]["mode"] != "open_license":
                    # Strict opt-in filter: public readability is not commercial reuse permission.
                    with db:
                        db.execute("INSERT INTO ingestion_items VALUES (?,?,?,NULL,?,'filtered',NULL,?)", (job_id, index, record_id, record_hash, timestamp))
                        db.execute("UPDATE ingestion_jobs SET checkpoint=?,updated_at=? WHERE id=?", (index + 1, timestamp, job_id))
                    audit.append({"id": record_id, "status": "filtered", "reason": "no explicit commercial-compatible open license classification"})
                    continue
                # Every document + all its references + checkpoint commit atomically.
                with db:
                    version_id = import_record(db, record, timestamp)
                    db.execute("INSERT INTO ingestion_items VALUES (?,?,?,?,?,'completed',NULL,?)", (job_id, index, record_id, version_id, record_hash, timestamp))
                    db.execute("UPDATE ingestion_jobs SET checkpoint=?,updated_at=? WHERE id=?", (index + 1, timestamp, job_id))
                active_versions.append(version_id)
                audit.append({"id": record_id, "status": "completed", "versionId": version_id, "resumed": False})
            except (ValueError, sqlite3.IntegrityError, KeyError, TypeError) as exc:
                file_errors += 1
                with db:
                    db.execute("INSERT OR REPLACE INTO ingestion_items VALUES (?,?,?,NULL,?,'quarantined',?,?)", (job_id, index, record_id, record_hash, str(exc), timestamp))
                    db.execute("INSERT OR REPLACE INTO quarantine_errors VALUES (?,?,?,?,?,?,?)", (digest([job_id, index]), job_id, index, record_id, record_hash, str(exc), timestamp))
                    db.execute("UPDATE ingestion_jobs SET checkpoint=?,updated_at=? WHERE id=?", (index + 1, timestamp, job_id))
                audit.append({"id": record_id, "status": "quarantined", "error": str(exc)})
        with db:
            db.execute("UPDATE ingestion_jobs SET status=?,updated_at=? WHERE id=?", ("completed_with_errors" if file_errors else "completed", timestamp, job_id))
    result = export_index(db, active_versions, output, commercial_only)
    # Keep immutable historical rows, but expose no stale active source after removal,
    # policy rejection or a selected rights-mode filter. A temp table avoids SQL variable
    # limits for large batches.
    with db:
        db.execute("CREATE TEMP TABLE IF NOT EXISTS build_active_versions (id TEXT PRIMARY KEY)")
        db.execute("DELETE FROM build_active_versions")
        db.executemany("INSERT INTO build_active_versions VALUES (?)", ((record["versionId"],) for record in result["documents"]))
        db.execute("UPDATE sources SET current_version_id=NULL,updated_at=? WHERE current_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM build_active_versions active WHERE active.id=sources.current_version_id)", (timestamp,))
    write_identity_registry(db, registry)
    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    foreign_key_errors = list(db.execute("PRAGMA foreign_key_check"))
    table_counts = {table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("sources", "document_versions", "film_entities", "passages", "observations", "evidence_links", "review_events", "ingestion_jobs", "quarantine_errors")}
    table_counts["active_sources"] = db.execute("SELECT count(*) FROM sources WHERE current_version_id IS NOT NULL").fetchone()[0]
    db.close()
    return {"corpusVersion": result["corpusVersion"], "stats": result["stats"], "databaseCounts": table_counts, "sqliteIntegrity": integrity, "foreignKeyErrors": len(foreign_key_errors), "quarantined": sum(r["status"] == "quarantined" for r in audit), "records": audit, "output": str(output)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "research/knowledge/records")
    parser.add_argument("--db", type=Path, default=ROOT / "work/knowledge/corpus.sqlite")
    parser.add_argument("--out", type=Path, default=ROOT / "research/knowledge/serving-index.json")
    parser.add_argument("--commercial-only", action="store_true", help="Export only records explicitly classified open_license; not legal clearance")
    parser.add_argument("--registry", type=Path, help="Persistent portable identity registry; defaults beside output")
    parser.add_argument("--audit", action="store_true", help="Include individual job/validation results in stdout")
    args = parser.parse_args()
    try:
        report = build(args.input, args.db, args.out, args.commercial_only, args.registry)
    except (OSError, ValueError, sqlite3.Error) as exc:
        print(f"Knowledge build failed: {exc}", file=sys.stderr)
        return 1
    if not args.audit:
        report.pop("records")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["quarantined"] or report["sqliteIntegrity"] != "ok" or report["foreignKeyErrors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
