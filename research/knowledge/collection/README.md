# STRADA collection framework

This directory is the controlled front door to the published corpus. Discovery, fetching and model extraction are **staging operations**. They cannot change production retrieval. Only a reviewed source record that passes the existing schema plus an exact-quote audit can be promoted into `records/`.

## State flow

`discovered → policy_checked → fetched → extracted → needs_review → source_audited → promoted`

Failures remain explicit: `duplicate_published`, `duplicate_in_job`, `policy_rejected`, `blocked`, `unreadable`, `invalid_model_output`, `rejected`. There is no fallback that silently converts a failed source into model knowledge.

- `sources.json` is the source-family allowlist. It fixes publisher identity, allowed hosts and paths, minimum readable text, request pacing, default source type and conservative rights classification.
- `jobs/*.json` contains bounded, reproducible URL batches. A target may point to a landing page plus a separate `textUrl`, but both must satisfy the same source-family policy.
- `manifests/*.json` is committed provenance: canonical URLs, hashes, byte/character counts and terminal status. It contains no publisher body text.
- `work/knowledge/collection/<job>/text/` contains fetched text and stays ignored. This prevents unlicensed full text from entering the repository.
- `work/knowledge/collection/<job>/batch-input.jsonl` contains optional offline extraction requests. It is never submitted by the preparation command.
- `work/knowledge/collection/<job>/review-candidates.json` contains untrusted model candidates. The production builder cannot read this shape.
- `records/*.json` remains the only published source input.

## Run a batch

```sh
npm run knowledge:collect -- --job research/knowledge/collection/jobs/pilot-scale-2026-09-20.json
npm run knowledge:collect -- --job research/knowledge/collection/jobs/pilot-scale-2026-09-20.json --run
npm run knowledge:prepare-batch -- --manifest research/knowledge/collection/manifests/pilot-scale-2026-09-20.json --model gpt-5.6-terra
```

The first command is a no-network plan. The second fetches independent hosts concurrently (`--concurrency 1..8`, default 4) while preserving per-host pacing, bounded responses, retries only transient failures, canonical-URL and content-hash deduplication, and per-item checkpoints. Rerunning reuses completed items unless `--refresh` is explicit. The third command creates JSONL for the Responses Batch endpoint; it refuses Sol models and performs no API call. OpenAI documents a maximum of 50,000 requests and 200 MB for a Batch input file, and the preparer refuses larger files. Split real work much earlier, normally into 50–200 documents, for reviewability and recovery.

If a batch is deliberately submitted, save its result JSONL under ignored work storage, then run:

```sh
npm run knowledge:review-batch -- \
  --manifest research/knowledge/collection/manifests/pilot-scale-2026-09-20.json \
  --results work/knowledge/collection/pilot-scale-2026-09-20/batch-output.jsonl
```

The review parser checks the structured shape, film-index references, the 25-word quotation ceiling and quotation presence in fetched text. It automatically blocks abstract-only academic candidates. Passing this parser means only “eligible to review.” A reviewer still checks the whole relevant passage, film identities, relation kind, summary, boundary and subjects.

## Promotion gate

Put completed, source-shaped records in a temporary reviewed JSON file, audit that file in isolation, then promote it into a new immutable batch name:

```sh
npm run knowledge:audit -- \
  --input work/knowledge/collection/JOB/reviewed-records.json \
  --out work/knowledge/collection/JOB/reviewed-audit.json

npm run knowledge:promote -- \
  --input work/knowledge/collection/JOB/reviewed-records.json \
  --audit work/knowledge/collection/JOB/reviewed-audit.json \
  --output research/knowledge/records/BATCH.json

# inspect the dry run, then repeat with --run
```

Promotion requires every document ID in the reviewed file to have `matched` audit status. It rejects existing IDs, canonical source-URL duplicates, malformed records, overlong quotations, missing references and abstract-only academic material. It will not overwrite a prior batch file. After promotion, rebuild, embed only uncached observations, run retrieval tests and deploy the serving artifacts.

## Scaling to tens of thousands

The framework scales by documents and observations, not every possible film pair. One multi-film programme remains one hyperedge observation. Fetching and offline extraction can be parallelized by independent jobs and source families; publishing remains a deterministic, reviewed gate. Hashes make fetch, extraction and embeddings incremental.

Keep the current bundled serving index while it is small. Track artifact size, cold-load time, retrieval p95 and per-seed evidence recall after each corpus tranche. Migrate the same stable source/version/observation IDs to the prepared PostgreSQL schema when the bundle or retrieval budget becomes material; do not redesign the evidence contract during that storage move. PostgreSQL full-text search and pgvector become retrieval adapters, while the one online curator call and bounded evidence context remain unchanged.

The framework improves throughput and provenance. It does not prove that extracted observations are insightful or that recommendation quality improved. Continue blind route-level evaluation on each thematic tranche and keep human/agent judgments separate from source admission.
