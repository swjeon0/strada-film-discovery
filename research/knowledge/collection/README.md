# STRADA automated collection framework

This directory is the controlled front door to the published corpus. Discovery, fetching, extraction, validation and publication are resumable jobs. No human-review state exists in the source schema or serving API.

## State flow

`discovered → policy_checked → fetched → extracted → automatically_validated → published`

Automatic admission is deliberately strict. A document is rejected when its source is blocked, duplicated or too short; an academic item is not full text; the structured response is malformed; its bounded quotation is absent from fetched publisher text; a film reference is invalid; or the film cannot be independently resolved against TMDB. Raw publisher text stays under ignored `work/` storage. Published records retain only short quotation anchors, original summaries and provenance.

- `sources.json` defines allowed hosts and paths, request pacing, source type and rights classification.
- `discovery/*.json` defines reproducible listing-page crawls and family quotas.
- `jobs/*.json` stores canonical document targets.
- `manifests/*.json` stores fetch provenance, hashes and terminal status without publisher body text.
- `records/*.json` is the only input read by the production corpus builder.

## Run a large tranche

```sh
npm run knowledge:discover -- --plan research/knowledge/collection/discovery/scale-500-2026-09-20.json --run
npm run knowledge:collect -- --job research/knowledge/collection/jobs/scale-500-2026-09-20.json --run --concurrency 8
npm run knowledge:prepare-batch -- --manifest research/knowledge/collection/manifests/scale-500-2026-09-20.json --model gpt-5.6-terra
npm run knowledge:run-batch -- --run
npm run knowledge:validate-batch -- --limit 500
npm run knowledge:publish -- \
  --input work/knowledge/collection/scale-500-2026-09-20/validated-records.json \
  --validation-report work/knowledge/collection/scale-500-2026-09-20/validation-report.json \
  --output research/knowledge/records/scale-500-2026-09-20.json \
  --run
npm run knowledge:build
npm run knowledge:embed -- --run
```

For one-off local corpus construction charged to the signed-in ChatGPT/Codex plan rather than the API Platform, use `knowledge:run-codex` instead of the two Batch commands. The runner refuses to start unless `codex login status` reports ChatGPT authentication and removes API-key and workload-identity variables from every child process:

```sh
npm run knowledge:run-codex -- \
  --manifest research/knowledge/collection/manifests/scale-500-pro-2026-09-20.json \
  --model gpt-5.6-terra --effort low --run
```

This path is resumable and writes the same validation input format as the Batch runner. It is appropriate for operator-run ingestion, not for STRADA's deployed request path.

After publishing a ChatGPT-plan tranche, rebuild semantic neighbors without an embeddings API call:

```sh
npm run knowledge:build
npm run knowledge:embed-local
```

The local index uses deterministic multilingual word, word-bigram and character-trigram TF-IDF feature hashing. Its artifact records `apiCalls: 0`; the deployed retriever consumes the resulting bounded neighbor graph rather than running this embedding model online.

Every command is restartable. Discovery excludes canonical URLs already in `records/`. Collection checkpoints after every target and reuses terminal results. The Batch runner stores its file and batch IDs without credentials and resumes polling the same input hash. Validation resolves unique films once and admits exactly the requested number; it fails instead of silently publishing fewer records. Publication is immutable and rejects duplicate IDs or URLs.

OpenAI's Batch API accepts Responses API requests and lowers asynchronous cost, while the local preparer enforces the documented 50,000-request and 200 MB input limits. Sol models remain disabled. The 500-document plan uses Terra because extraction quality matters more than using the smallest model.

## Scaling beyond this tranche

Scale documents and observations rather than expanding every programme into all possible film pairs. Fetch and extraction jobs can run independently; hashes make retries, embeddings and source updates incremental. Track accepted-source yield, duplicate rate, quote-match rate, film-resolution rate, serving artifact bytes, cold-load time, retrieval p95 and per-seed evidence recall for every tranche.

The bundled serving index remains practical for this initial scale. When bundle size or cold-load time becomes material, move the same stable IDs and tables to the prepared PostgreSQL schema and replace only the retrieval adapter. Keep the bounded evidence contract and one online curator call unchanged.
