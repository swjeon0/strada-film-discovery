# CLOSEUP

CLOSEUP is a desktop film-discovery app: choose 1–8 starting films, inspect recommendation sources, then follow a film to change the direction of the trail. The interface is designed around a 1440 × 900 desktop viewport.

## Run locally

Use Node.js 22.13 or newer. From the `closeup` project directory:

```sh
npm run install:ci
npm run dev
```

The portable development server starts on port 5173; use the loopback URL printed by the server. For a local production-build check:

```sh
npm run build
npm start
```

These commands build or preview locally; they do not publish the site. Managed previews should retain the project's configured execution profile and preview supervisor.

## Reference collection and live research

Without provider credentials, CLOSEUP works with its bundled **16-film reference collection**. Search covers those films by title, director, or Korean alias. Recommendations follow the collection's cited comparisons and clearly labeled curatorial readings, with recent follows receiving more influence. The interface identifies this as a reference collection; it is not live AI research. Some trails exhaust the available connections, and a complete 12-film batch is not guaranteed.

Live search and research currently activate only when **both** server credentials are configured. For local development, create an ignored `.env.local` in the project root:

```dotenv
OPENAI_API_KEY=your_openai_api_key
TMDB_READ_ACCESS_TOKEN=your_tmdb_read_access_token
OPENAI_MODEL=gpt-6-astra
```

The model setting is optional; its default is `gpt-6-astra`. Use a TMDB API Read Access Token, not a browser login cookie. Keep all credentials server-side: never add `NEXT_PUBLIC_`, commit secret values, or put them into a client component. Restart the development server after changing the local environment. For the hosted app, set the same names through its server-secret configuration; local files do not provision production secrets. Cloudflare's Vite plugin supports ignored `.env.local` values for local Worker bindings. [Environment handling](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/).

`GET /api/status` reports the configured mode and credential-presence booleans without exposing values. Presence does **not** prove that a key works or that the account can use the selected model. Before enabling live access for visitors, run one real search and one small recommendation request, verify citations, and confirm the host's runtime limits and request-rate controls. The live path has not been exercised with provider credentials in this handoff.

## Data and evidence limits

CLOSEUP has no database, account system, cloud trail storage, or migration requirement. The current browser saves a versioned session in localStorage (`closeup.session.v2`). Undo and History restore saved batches without another model request. Clearing browser data removes this session; private browsing or storage restrictions can prevent persistence. Live generation sends the selected film context to the server and OpenAI, and retrieves metadata from TMDB.

Live research makes a bounded OpenAI Responses request using web search and a strict output schema. The server checks returned source URLs against search provenance and permitted publisher hosts, inspects readable HTML, checks supporting text, and resolves film identities through TMDB. Unreadable, unsupported, ambiguous, or duplicate candidates are excluded; partial batches are expected. PDFs, paywalled full texts, client-rendered pages and pages beyond the reader's size/time limits may not qualify.

Text/provenance checks reduce unsupported claims; they do not prove the semantic truth of a recommendation. Direct comparisons, contextual material and CLOSEUP interpretations must remain distinguishable. Source summaries should be checked against the linked originals before treating them as research conclusions. Source availability, provider model access, latency and quotas can change. A failed or canceled Follow keeps the committed trail unchanged.

Film posters and source texts retain their original rights. The Credits dialog identifies source/metadata providers. Live TMDB use requires its approved attribution and the appropriate terms for the intended deployment.

## Implementation

- React and Vinext on a Cloudflare Worker; route handlers keep credentials off the client.
- `lib/curated-catalog.json`: 16 films, 22 sources and 32 bidirectional relationships. `lib/catalogue.ts` ranks only these verified relationships in collection mode.
- `lib/domain.ts`: versioned snapshots, recency weights, validation and history. Seeds share an initial weight of one; each Follow decays existing raw weights by 0.7 and adds the latest film at one, then normalizes. No visible score or rating is shown.
- `lib/server/research.ts`: searched sources, strict structured output, per-anchor evidence gates and film identity resolution. The private supporting span must name the supported films and occur in inspected source text. Validation is conservative and may return fewer films.
- `app/page.tsx`: one entry/result surface, evidence drawer and shared UI/WebMCP actions. There is no database or app-owned authentication. The deployment itself is owner-private.

A trail accepts 1–8 unique seeds and at most 30 Follow steps. Follow commits only a nonempty verified batch. Undo moves a cursor without deleting later steps; following from an earlier step replaces that suffix only after success. Starting a new trail replaces the saved trail only after successful generation. Draft seeds and history are stored in this browser.

Live work has a 115-second total deadline and a shared upstream-call budget. A local guard allows two concurrent research calls and 12 starts per caller in ten minutes per Worker isolate; it is not a distributed quota. Configure a platform rate limit before broadening access to a public live app. Request bodies and source streams are capped while reading.

## Validation

`node --import tsx --test tests/core.test.ts` checks catalogue integrity, exclusion, recency weighting, history branching, storage validation and evidence URL/span gates. `node node_modules/typescript/bin/tsc --noEmit` checks types. Run the standard Sites build before publishing.

Live OpenAI/TMDB credentials were unavailable at delivery; model calls and deployed live source retrieval remain activation checks. The finite collection is functional and does not consume model tokens.
