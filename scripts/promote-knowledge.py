#!/usr/bin/env python3
"""Promote reviewed records only after an exact-quote source audit passes."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]


def load_builder():
    path = ROOT / "scripts/build-knowledge.py"
    spec = importlib.util.spec_from_file_location("strada_build_knowledge", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the corpus validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_url(raw: str) -> str:
    value = urlsplit(raw)
    query = urlencode([
        (key, item)
        for key, item in parse_qsl(value.query, keep_blank_values=True)
        if not key.lower().startswith("utm_")
        and key.lower() not in {"fbclid", "gclid", "mc_cid", "mc_eid"}
    ])
    path = value.path.rstrip("/") or "/"
    return urlunsplit((value.scheme.lower(), value.netloc.lower(), path, query, ""))


def read_existing(root: Path) -> list[dict]:
    rows: list[dict] = []
    for path in sorted(root.glob("*.json")):
        value = json.loads(path.read_text())
        if not isinstance(value, list):
            raise ValueError(f"{path}: expected an array")
        rows.extend(value)
    return rows


def validate_promotion(records: object, audit: object, existing: list[dict]) -> list[dict]:
    if not isinstance(records, list) or not records:
        raise ValueError("Reviewed input must be a nonempty JSON array")
    if not isinstance(audit, dict) or not isinstance(audit.get("documents"), list):
        raise ValueError("A source-audit report is required")
    builder = load_builder()
    validated = [builder.validate_record(row) for row in records]
    ids = [row["id"] for row in validated]
    if len(ids) != len(set(ids)):
        raise ValueError("Reviewed input contains duplicate document IDs")
    existing_ids = {row["id"] for row in existing}
    duplicates = sorted(existing_ids.intersection(ids))
    if duplicates:
        raise ValueError(f"Document IDs already published: {', '.join(duplicates)}")
    existing_urls = {
        canonical_url(url)
        for row in existing
        for url in [row["url"], row.get("verification", {}).get("textUrl")]
        if url
    }
    new_urls: set[str] = set()
    for row in validated:
        for raw in [row["url"], row.get("verification", {}).get("textUrl")]:
            if not raw:
                continue
            url = canonical_url(raw)
            if url in existing_urls or url in new_urls:
                raise ValueError(f"Source URL already published or repeated: {url}")
            new_urls.add(url)
    audited = {row.get("documentId"): row for row in audit["documents"]}
    if set(ids) != set(audited):
        raise ValueError("Audit document IDs must exactly match reviewed input")
    failures = [source_id for source_id in ids if audited[source_id].get("status") != "matched"]
    if failures:
        raise ValueError(f"Exact-quote audit did not pass: {', '.join(failures)}")
    return validated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    source = json.loads(args.input.read_text())
    audit = json.loads(args.audit.read_text())
    existing = read_existing(ROOT / "research/knowledge/records")
    validated = validate_promotion(source, audit, existing)
    if args.output.exists():
        raise ValueError("Promotion output already exists; use a new immutable batch file")
    result = {"records": len(validated), "output": str(args.output), "written": args.run}
    if not args.run:
        result["hint"] = "Add --run after reviewing the exact output path."
        print(json.dumps(result))
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=args.output.parent, delete=False) as handle:
        json.dump(validated, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(args.output)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
