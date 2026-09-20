# STRADA corpus scalability and evaluation pilot

This research harness is isolated from the production request path. It tests the corpus shape before the app adopts it.

## Design

`schema.sql` stores immutable source versions, passages, mentions, attributed claims, claim operations, hyperedge relations, review work, and recommendation judgments separately. A retrospective or festival programme is one relation with many participants; it is never expanded into every possible film pair. A claim can carry several operations, so an attributed formal comparison does not have to be forced into one lossy label.

The ingestion path is resumable and idempotent:

1. Fetch a document and hash the raw version.
2. Segment it deterministically and hash each passage.
3. Link known film titles before using an LLM.
4. Send only mention neighborhoods and curatorial language to structured extraction. The LLM selects from linked entity IDs; it does not invent or normalize film names.
5. Store claims and relations with polarity, attribution, scope, and confidence.
6. Route blocked pages, uncertain identity matches, counterclaims, and low-confidence extraction to `review_queue`.
7. Embed accepted passages and claims asynchronously in the production PostgreSQL/pgvector deployment.

SQLite is used only for the portable pilot. The table boundaries and indexes map directly to PostgreSQL. Raw documents belong in object storage; the database stores hashes and locators rather than duplicating every fetched file.

## Evaluation

`evaluate.mjs` performs three checks:

- normalizes the 50 manually reviewed pilot records into the relational schema;
- runs a synthetic transaction and indexed relation-query stress test;
- with `--run`, tests structured extraction on a stratified set and compares source-first web recommendations with and without the corpus context. Generation uses `gpt-5.4-mini`; the blind proxy judge uses `gpt-5.6-terra`. It never uses Sol.

Run from the `closeup` directory with the bundled Node runtime available in `PATH`:

```bash
node research/corpus/evaluate.mjs
node research/corpus/evaluate.mjs --run
```

The paid branch requires `OPENAI_API_KEY` in `.env.local`. Runtime artifacts are written under `../work/strada-corpus-eval/` and never contain API keys.
