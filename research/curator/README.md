> Current production uses the compiled literature corpus in `research/knowledge`, not the historical 17-passage snapshot. The benchmark and quality CLI now use `CorpusKnowledgeRepository`; historical reports retain their original snapshots and results.

# STRADA `curator_v1` experiment

This directory contains stage 1 and stage 1.5 of the high-context curator roadmap. The one-main-call engine and its bounded identity-repair path are connected to production through `lib/server/curator-production.ts`; the reports below preserve the evidence available at each historical decision point.

## What it establishes

- One main LLM call reads every selected film as an equal-weight set.
- A fixed context snapshot supplies checked passages without becoming a closed candidate pool.
- The model may propose any real film it knows.
- Each primary bridge is labelled `source_explicit`, `source_supported_interpretation`, or `model_proposal`.
- The compact response is exactly one ranked route of 12 equally specified films. There is no separate reserve logic or hidden candidate pool.
- Local catalogue/TMDB resolution verifies all 12 title/year/director identities and rejects unresolved, duplicate, input, or previously shown films. It checks original and alternative titles and, when title search is weak, the named director's filmography.
- If any slots fail identity verification, one bounded replacement-only call repairs those positions and the whole 12 is verified again. This is an exceptional identity recovery step, not a second candidate-ranking pipeline. Only a complete verified 12-film route reaches the UI.
- Sol is rejected in both the CLI and runtime.

The 17-passage snapshot is an experimental fixture: criticism 10, programme notes 3, festival texts 2, and academic texts 2. Retrieval now omits zero-score passages. Monographic records enter the online prompt as checked critical descriptors; bounded source text is retained only for relational records. `human_checked` means the excerpt and locator were inspected during implementation. It is not an expert endorsement of the interpretation. Existing corpus summaries remain separate and are not treated as quotation evidence.

## Run it

Dry run, with no API charge or backend import:

```bash
npm run benchmark:curator-v1 -- --case matter-and-sky
```

One live run with the current production configuration:

```bash
npm run benchmark:curator-v1 -- --run --case matter-and-sky --models gpt-5.6-terra --reasoning none --deadline-ms 15750 --max-output-tokens 2000 --out work/curator-v1-matter.json
```

The fixed pilot set is 12 cases. Start with one run per case; use a second repeat only when measuring variance:

```bash
npm run benchmark:curator-v1 -- --run --case all --models gpt-5.6-terra --repeat 1 --reasoning none --deadline-ms 15750 --max-output-tokens 2000 --out work/curator-v1-current.json
```

Reports contain inputs, resolved film metadata, separate context/model/resolution timings, attribution counts, and provider usage estimates. They never contain API keys or authorization headers. Output files are created with mode `0600` and are never overwritten.

## Stage boundary

Stage 1 tests feasibility and contracts. The current product target is one main curator call, identity verification, and any exceptional slot repair inside 20 seconds. It does not claim expert-level recommendation quality. Blind human comparison, judgement labels, and model learning belong to later evaluation stages.

The historical feasibility decision is in `stage-1-report-2026-09-20.md`. The current model, prompt philosophy, resolver, 20-second measurements, and quality limits are in `stage-1.5-quality-pilot-2026-09-20.md`.

## Stage 1.5 quality gate

Stage 1.5 asks which complete recommendation list a blind human reviewer would actually rather receive. It has no expected film list and never uses target recovery as recommendation quality.

The A/B conditions explicitly use the same `v2` curation prompt, main model, output contract, token budget, deadline, metadata resolution, and conditional identity-repair policy:

- `baseline`: selected-film metadata with an empty literature context.
- `candidate`: selected-film metadata with the fixed reviewed context snapshot.

The raw report contains the private A/B map. Reviewers should receive only the two blind packets and a separate copy of the ratings template. One packet shows selection metadata only; the other shows the actual route and connection copy. A reviewer first scores each list independently on six axes—input reading, connection specificity, discovery value, curatorial judgement, list composition, and trustworthiness—then makes an A/B/tie choice. The rubric accepts any convincing curatorial relation, including direct production and personnel links; it does not reward an abstract critical thesis by default.

```bash
npm run evaluate:curator-v1-quality -- --run --case all --repeat 1 --model gpt-5.6-terra --deadline-ms 20000 --max-output-tokens 2000 --out work/curator-v1-quality.json
```

The command writes:

- the private raw report and A/B map;
- `*-blind-selection.md`;
- `*-blind-full.md`;
- `*-human-ratings.json`.

Make one ratings-template copy per reviewer and use distinct `reviewerId` values. After at least three independent human reviews, score them without exposing the map during review:

```bash
npm run score:curator-v1-quality -- --report work/curator-v1-quality.json --ratings work/reviewer-1.json,work/reviewer-2.json,work/reviewer-3.json --out work/curator-v1-quality-human-score.json
```

The scorer clusters repeated runs by seed case and reports pairwise preference plus absolute listwise quality. A release pass requires at least 40 holdout cases; the current 12-case suite is a harness/pilot and cannot establish the release gate by itself. LLM judges may be used for development triage, but the scorer rejects non-human packets and LLM votes never enter the gate.

### Documented-relation diagnostic

The former hidden-target evaluator remains available under an explicit diagnostic name:

```bash
npm run diagnose:curator-v1-relation-recall -- --run --out work/curator-v1-relation-recall.json
```

Its dossier deliberately contains the target relation, so it measures only whether a known documented relation survives retrieval and selection. It is not a recommendation-quality benchmark or release gate. The historical result is retained in `relation-recall-diagnostic-2026-09-20.md`.
