# STRADA knowledge corpus v1

This is a document-centered research corpus, not a list of predetermined recommended films. The production curator can recommend films outside this corpus. Validated observations supply context and traceable evidence; TMDB separately verifies film identities.

## Current corpus snapshot

The active serving snapshot contains 579 documents, 820 canonical films, 582 passages and 588 observations. The latest tranche discovered 700 readable publisher pages and automatically published exactly 500 records after structured extraction, exact-quote matching, academic full-text enforcement, schema validation and independent TMDB identity resolution. It added 62 BFI/Sight and Sound criticism records and 438 Harvard Film Archive programme records. These counts describe corpus coverage, not demonstrated recommendation quality.

The tranche deliberately emphasizes programme notes and criticism with concrete formal, historical or programming context. It is a throughput and admission test rather than a balanced final corpus: academic full texts and additional publishers should enter as separate source-family tranches instead of being simulated from abstracts or metadata pages.

## Portable inputs and build products

- `records/*.json`: actual source access records, bounded verbatim quotations and separately authored paraphrases. These are the authoritative document inputs. A record does **not** claim complete ingestion of a document merely because `access` says `full_page`.
- `film-identity-registry.json`: durable canonical film IDs, known title aliases and original record keys. Commit this with new records so adding a differently titled source cannot silently rename an existing film during a clean rebuild.
- `schema.sql`: normalized local ingestion schema. SQLite is the local working database, not a Vercel database service.
- `work/knowledge/corpus.sqlite`: ignored working database with immutable versions, normalized references, job checkpoints and quarantine records. Source edits append a new version; they do not rewrite the previous version. Sources removed from accepted input or disallowed by admission policy have `current_version_id` cleared. Their old versions are retained as history only and never served.
- `serving-index.json`: compact validated snapshot imported by the production retrieval adapter. Export includes only the records in the current input set, not deleted or historical records lingering in SQLite. This keeps requests independent of network database cold starts at the present pilot size.
- `semantic-neighbors.json`: independently generated, bounded neighbor lists for observations. Embedding generation happens offline; online retrieval does not call an embedding API.
- `migrations/001-postgres.sql` and `002-pgvector-optional.sql`: future storage adapter migrations. No hosted PostgreSQL service is currently implied or provisioned by these files.

## Database relationships

`sources → document_versions → passages / observations`

`observations → observation_participants → film_entities → aliases`

`observations → evidence_links → passages`

The observation is the primary retrieval unit. A comparison, contrast, influence claim, historical context, single-film reading, incidental mention and co-programming event remain distinct `kind` values. A program containing several films is **one** observation with multiple participants; it is not expanded into all possible film pairs. A comparison is only recorded when the document actually makes it.

The short quotation is an audit anchor, stored in `passages.exact_quote`. The original paraphrase, Korean paraphrase, limitations and subjects live in `observations`. `evidence_links.support_scope` explicitly says the tiny quotation alone does not entail every detail of the broader article paraphrase. The original URL, author, publication date, access scope, locator, rights classification and verification note remain in the immutable version and serving document.

`curation_cases` and `judgments` remain separate empty-by-default tables for later recommendation outputs and preference judgments. Source admission does not depend on those evaluation records.

`observation_embeddings` is populated after each offline embedding build. It stores the exact versioned observation ID, model, dimensions, input hash, vector JSON, generation time and import time. The importer reconstructs the embedding input from both the serving record and SQLite observation, compares them, and accepts only the active document version. The hash is the identical UTF-8 SHA256 of `model:dimensions:text` used by the TypeScript embedding script. Repeated imports reuse the existing row; changed observations append a new version's vector. Removed source vectors remain historical and are excluded by the active source-version join.

New cache vectors record a per-hash `generatedAt`. The original pilot cache did not record generation timestamps; imported legacy vectors explicitly store `unknown_legacy_cache`, alongside their actual `imported_at`, rather than inventing a generation date. Hash-based caches allow only changed observations to need re-embedding. The optional PostgreSQL adapter adds a 256-dimensional vector column and index without replacing this provenance.

## Film identity

Normalize Unicode/diacritics, punctuation and case, then match title or documented alias **with exact year and normalized director**. Do not merge based on title alone. A stable canonical film key initially hashes that identity; the committed registry preserves it as aliases are added. Source-local keys survive in `keyMappings` and `films[].sourceKey`.

An original key reused with another year/director, conflicting external IDs, or an alias bridging multiple existing entities is quarantined. This intentionally favors manual reconciliation over an unsafe merge. Romanized director aliases are not guessed; correct the source record or explicitly reconcile the registry after validation. TMDB metadata validation remains independent.

## Build and expand

From the `closeup` directory:

```sh
python3 scripts/build-knowledge.py --audit
python3 -m unittest discover -s research/knowledge/tests -v
node --import tsx scripts/embed-knowledge.ts --run --cache-only
```

The last command regenerates neighbors and imports the existing cache into SQLite without allowing any new API request. If a vector is missing, it fails before network access. Omit `--cache-only` when intentionally embedding new annotations. To persist an existing cache alone, run `python3 scripts/import-knowledge-embeddings.py`; `--index`, `--cache` and `--db` support isolated checks. A build must precede embedding import so active version IDs match. The cache, SQLite database and embedding-run report remain under ignored `work/knowledge/`; no live request opens them.

The builder uses Python's standard library and makes **zero network/API calls**. `--input` accepts a JSON file or directory. `--db`, `--out`, and `--registry` allow isolated corpus builds. Defaults are `research/knowledge/records`, `work/knowledge/corpus.sqlite`, `research/knowledge/serving-index.json`, and the sibling identity registry.

Each file has an input-hash job ID. Each document, all normalized children, its item result and the job checkpoint commit in one transaction. Rerunning unchanged input skips completed documents; a crash resumes at completed item checkpoints. Invalid documents are quarantined, other documents continue, and the command returns nonzero. Editing a quarantined record creates a new input-hash job. Build failures must be fixed before release. `--audit` reports individual validation results as JSON.

To add documents: run the collection pipeline, which records source access and rights, creates bounded records following `record-format.md`, and then runs the builder. Inspect quarantine counts and the corpus diff. Regenerate semantic neighbors from changed observation hashes, run retrieval/evidence tests and a small live recommendation regression, and deploy the new artifacts together. Do not upload raw PDFs or article text whose reuse rights are unestablished.

For repeatable collection, use [`collection/README.md`](collection/README.md). Its URL jobs, source-family policy, resumable fetch manifests, Batch extraction, automatic validator and immutable publication gate keep raw acquisition outside the serving corpus. A fetched document enters production only after every automatic admission check passes.

For a clean reproducibility check, use a new SQLite path with the same records and committed registry, then compare `corpusVersion` and exported documents/films. Two unchanged builds preserve the exact serving artifact including `builtAt`; working job metadata does not alter its fingerprint.

## Access and rights are explicit data

**Academic sources require actual access to the full text and `access: "full_page"`. Abstract-only and metadata-only academic records are rejected, quarantined and never served.** This policy is enforced before resume checkpoints, in the serving export, and for newly inserted database versions. Historical abstracts are retained only as inactive history. A landing page showing an abstract does not qualify as full-text access. Optional `verification.textUrl` preserves the actually accessed original PDF or full-text page while `url` remains the public source page. Non-academic records still preserve their actual access scope; no record may imply more text was read than was actually accessible.

Free online access is not an open license. Retain `restricted_excerpt` unless explicit permission establishes `open_license` or `noncommercial`. The builder enforces no more than 25 quoted words and 160 derived prose words per document, including translations and boundaries; the automated batch validator uses a stricter 20-word quotation limit. Collection fetches publisher text and the validator requires each published quotation to occur in that fetched text. The builder itself remains offline and therefore does not refetch a publisher page during every rebuild.

```sh
python3 scripts/build-knowledge.py --commercial-only --db work/knowledge/commercial.sqlite --out work/knowledge/commercial-index.json --registry research/knowledge/film-identity-registry.json
```

This conservative filter includes only explicitly classified `open_license` records. It excludes both noncommercial and restricted-excerpt records; it is not a legal clearance service. Use different database and output paths so research-mode evidence and active-source membership are not replaced. Source IDs remain unchanged across modes.

## Growth plan and limits

The normalized schema grows with the number of observations and participants, not the square of films in programs. Indexed participant lookup, passage lookup, version hashes, per-file jobs, per-document transactions and deterministic embedding-input caches support incremental batches. Keep discovery and fetch jobs checkpointed; publication files may contain 500 records because each document still commits atomically. Parallel fetching/extraction workers can later feed this same input contract; SQLite ingestion currently has a single writer.

The serving artifact is intentionally an initial implementation. It is loaded into application memory, so unbounded literature growth must not be handled by indefinitely enlarging the bundle. Track artifact bytes, startup time and retrieval p95 as the corpus expands. When these exceed deployment budgets, move identical tables and IDs to PostgreSQL, replace the retrieval storage adapter with indexed SQL/full-text/vector queries and keep the same bounded context and source-card contract. The migration is prepared, not claimed to have been load-tested or deployed. Preserve the curated passages, observations and user evaluation history through that move.

The offline tests verify idempotence, immutable versions, stable alias keys through a clean rebuild, missing-reference quarantine, per-document rollback, rechecks without duplicate versions, corrected-job resumption, conservative rights filtering, metadata scope, source deletion/deactivation and many-participant program storage. Academic admission tests explicitly reject abstracts, accept accessed full text, deactivate removed papers, and block direct export of historical abstract-only versions. Embedding tests cover bilingual hash compatibility, idempotent import, changed/removed source versions, stale or tampered index rejection, atomic rollback for malformed vectors and preservation of unknown legacy generation times. These are structural checks, not proof of recommendation quality or full web quote validation.
