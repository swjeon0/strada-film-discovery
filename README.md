# STRADA

A desktop film-discovery app. Choose 1–8 starting films, read why another film connects to them, then continue with that film to change your path. No database, app accounts or social features. The cream interface uses a Bodoni Moda wordmark and a broad film-strip path mark.

## Run locally

Use Node.js 22.13 or newer:

```sh
npm run install:ci
npm run dev
```

The portable server prints its loopback address on port 5173. Local build commands do not publish the site. Retain the configured Sites execution profile and use the Sites build/package workflow when publishing.

Create an ignored `.env.local`:

```dotenv
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.6-luna
# Optional; Wikimedia search works without this token:
TMDB_READ_ACCESS_TOKEN=
```

Keep credentials server-side; never use NEXT_PUBLIC_ or commit their values. Local environment files do not provision the hosted site's secrets. The existing hosted Site remains owner-private. Its URL is preserved so existing browser history can migrate.

## Films, language and sources

English/Korean controls appear on entry and results. Film names use actual database labels, never AI-generated translations; an unavailable Korean title keeps the database's existing title. Brand text stays STRADA.

Search queries external Wikidata and resolves film entities, years and directors; Wikipedia provides available synopsis excerpts and representative images. This covers films beyond the bundled 16. Coverage, images and Korean descriptions vary. TMDB is an optional alternate provider. No promise of every film ever made or a poster for every result is made.

Movie details prioritize a genuine Plot/Synopsis excerpt, with linked attribution. If one is unavailable, the introductory description is shown. Wikipedia text is CC BY-SA; Wikidata structured data is CC 0; images and criticism retain their original rights. The Credits dialog exposes these links. Bodoni Moda's OFL license is included with its local font.

Without an OpenAI key, the cited 16-film reference collection remains usable and visibly identified. Live metadata search and synopsis do not require an OpenAI key. The optional TMDB credential path has not been exercised with a real token.

## Recommendation pipeline and cost controls

The default model is gpt-5.6-luna: a low-cost model supporting Responses, web search and structured output, with reasoning disabled. The server performs two bounded passes:

1. Discover criticism, scholarship or substantive festival writing, using a web-search request with max_tool_calls 1 and up to 1600 output tokens. Retain URLs with real search provenance; known seed essays can supplement them.
2. Fetch at most 8 allowed public HTML pages, under a shared request/size/time budget. Give the model numbered, real source passages; request at most 8 candidates and 7000 output tokens without additional tools.

The server verifies source/page identities, passage references and film mentions for each candidate/anchor, then resolves movie identity through the film database. Explicit comparisons require both films in one cited passage; interpreted routes are distinguished. Invalid optional connections do not earn overlap credit. An unsupported primary connection drops the candidate. Partial or empty results are intentional; the app never invents filler.

These mechanical checks establish provenance and textual support, not semantic certainty. Interpretation and source summaries remain model-written readings that users can inspect against the linked original. Inaccessible pages, PDFs and ambiguity can shorten a batch.

Why text is generated in English and Korean together, targeting 70–100 English words. Language changes, synopsis reads, Undo and History do not call GPT. Only initial discovery and a successful continuation request initiate research. There are no automatic paid retries or model escalation. Identical ordered seeds/trail reuse a bounded 30-minute in-memory cache, including empty batches; concurrent identical requests share work. This is per Worker instance and is not durable across restarts. Usage estimates are returned without secrets; cached responses report zero new usage.

Measured development attempts cost an estimated US$0.011–0.031 each, including search and tokens; actual charges depend on provider usage/pricing and retrieval behavior. The tool-call limit is sent to the provider; returned web-search actions are counted for estimates. This is not an account-level spending cap.

Recency uses 0.7 decay. Genuine support from multiple distinct anchors earns a modest 6%bonus per extra anchor, capped at 12%. Greedy ranking then reduces repetition by director, country, decade and genre, with a small penalty for recently seen suggestions. No visible numerical score is shown.

## State and boundaries

`strada.session.v2` in localStorage holds validated snapshots and the draft. Existing `closeup.session.v2` data is migrated without changing film identities. Failed/canceled Follow keeps the committed path. Undo moves the cursor; History restores exact saved films and evidence without research. A successful branch replaces later snapshots only after its new batch arrives. Limits:8 seeds and 30 follows.

The app uses React/Vinext on a Cloudflare Worker. Metadata and research routes keep keys off the client. The research deadline is 115 seconds. Request bodies and source streams are capped. Per-instance controls allow 2 concurrent calls and 12 starts per caller in 10 minutes; these are not distributed quotas. Broader public use would need platform-level controls.

WebMCP tools share UI actions. Registration, read, language, staging and intentional failure paths were checked in the supported browser. Long-running discovery exceeded that browser tool's execution deadline; the full successful WebMCP Follow/Undo cycle remains unverified. UI snapshot branching is covered by unit tests.

## Validation

```sh
node --import tsx --test tests/core.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Checks cover history, storage, exclusion, recency, overlap/diversity and evidence gates. Real external searches found Interstellar, Parasite and Inception, including database Korean labels. The OpenAI key/model authenticated. Captured real model output was replayed through the repaired evidence/metadata pipeline with paid calls disabled: A Moment of Innocence and Citizen Kane passed with two readable criticism sources and 81/83-word explanations. Development fixtures remain outside the deployment source.
