import assert from "node:assert/strict";
import test from "node:test";
import { RecommendationSchema, type Film } from "../lib/domain";
import { RecommendationInput } from "../lib/server/recommendation-input";
import {
  curatorProductionExclusions,
  runCuratorProduction,
} from "../lib/server/curator/production";
import type { ContextBundle } from "../lib/server/curator/contract";
import type { KnowledgeRepository } from "../lib/server/knowledge/repository";
import type { runCurator } from "../lib/server/curator/engine";
import type { getFilms } from "../lib/server/metadata";

const a: Film = {
  id: "tmdb:2",
  title: "Second Seed",
  year: 2002,
  director: "Director Two",
  poster: "",
};
const b: Film = {
  id: "tmdb:1",
  title: "First Seed",
  year: 2001,
  director: "Director One",
  poster: "",
};
const input = RecommendationInput.parse({
  requestId: "request-1",
  baseSnapshotId: "snapshot-0",
  seeds: [a.id],
  trail: [b.id],
  language: "ko",
  intent: "regenerate",
  previousIds: ["tmdb:80"],
  seenIds: ["tmdb:81"],
  discoveredFilms: [
    { id: "tmdb:82", title: "Shown", year: 1982, director: "Director" },
  ],
});

const context: ContextBundle = {
  version: 1,
  corpusVersion: "test",
  builtAt: "2026-09-20T00:00:00.000Z",
  selectedFilmIds: [a.id, b.id].sort(),
  legacyNotes: [],
  passages: [
    {
      id: "p1",
      documentId: "d1",
      title: "A critical comparison",
      author: "Critic",
      publisher: "Journal",
      url: "https://example.com/essay",
      type: "criticism",
      locator: "paragraph 2",
      excerpt:
        "A sufficiently long checked passage about the selected film and its form.",
      filmIds: [a.id],
      subjects: ["Candidate 0"],
      contentKind: "exact_passage",
      reviewState: "human_checked",
      rights: "quotation_for_research",
    },
  ],
};

test("production exclusions retain freshness rules without turning history into weights", () => {
  assert.deepEqual(
    curatorProductionExclusions({ ...input, intent: "initial" }, [a.id, b.id]),
    [b.id, a.id],
  );
  assert.deepEqual(
    curatorProductionExclusions({ ...input, intent: "follow" }, [a.id, b.id]),
    [b.id, a.id, "tmdb:80"],
  );
  assert.deepEqual(curatorProductionExclusions(input, [a.id, b.id]), [
    b.id,
    a.id,
    "tmdb:80",
    "tmdb:81",
    "tmdb:82",
  ]);
});

test("production adapter performs one context read and one curator call in stable equal-weight order", async () => {
  let contextReads = 0,
    calls = 0;
  let captured: Parameters<typeof runCurator>[0] | undefined;
  const repository: KnowledgeRepository = {
    fingerprint: () => "repo-test",
    buildContext: async (selected) => {
      contextReads++;
      assert.deepEqual(
        selected.map((film) => film.id),
        [b.id, a.id],
      );
      return context;
    },
  };
  const candidates = Array.from(
    { length: 12 },
    (_, index) =>
      ({
        id: `tmdb:${100 + index}`,
        title: `Candidate ${index}`,
        year: 1970 + index,
        director: `Director ${index}`,
        poster: "",
      }) satisfies Film,
  );
  const fakeRun = (async (value) => {
    calls++;
    captured = value;
    assert.strictEqual(
      await value.repository.buildContext(value.selected, value.language),
      context,
    );
    return {
      decision: {
        lens: "시간과 물질이 역사를 드러내는 하나의 경로",
        description: "시간과 물질이 역사를 드러내는 하나의 경로",
        recommendations: candidates.map((film, index) => ({
          film,
          anchorIds: [b.id, a.id],
          connection: `후보 ${index}가 두 영화의 형식적 문제를 변형한다`,
          evidenceIds: index === 0 ? ["p1"] : [],
          attribution:
            index === 0
              ? ("source_explicit" as const)
              : ("model_proposal" as const),
        })),
      },
      contextFingerprint: "repo-test",
      contextPassageCount: 1,
      contextCoverage: { [a.id]: 1, [b.id]: 0 },
      model: "gpt-5.4-mini",
      usage: {
        model: "gpt-5.4-mini",
        inputTokens: 10,
        outputTokens: 20,
        searchCalls: 0,
        estimatedUsd: 0,
      },
      repair: { attempted: false },
      timings: {
        contextMs: 0,
        modelMs: 7,
        resolveMs: 2,
        repairMs: 0,
        totalMs: 9,
      },
    };
  }) as typeof runCurator;
  const fakeGetFilms = (async (ids) =>
    ids.map((id) => (id === a.id ? a : b))) as typeof getFilms;
  const result = await runCuratorProduction(
    input,
    new AbortController().signal,
    {
      repository,
      runCurator: fakeRun,
      getFilms: fakeGetFilms,
      detailToken: (rec) => `detail:${rec.film.id}`,
    },
  );
  assert.equal(contextReads, 1);
  assert.equal(calls, 1);
  assert.deepEqual(
    captured?.selected.map((film) => film.id),
    [b.id, a.id],
  );
  assert.deepEqual(captured?.excludedIds, [
    b.id,
    a.id,
    "tmdb:80",
    "tmdb:81",
    "tmdb:82",
  ]);
  assert.deepEqual(captured?.forbiddenFilms, [input.discoveredFilms[0]]);
  assert.deepEqual(captured?.options, {
    model: "gpt-5.6-terra",
    reasoning: "none",
    timeoutMs: 15750,
    maxOutputTokens: 2000,
    promptVersion: "v2",
    repair: {
      model: "gpt-5.4",
      reasoning: "none",
      timeoutMs: 3750,
      maxOutputTokens: 1100,
    },
  });
  assert.deepEqual(
    result.seeds.map((film) => film.id),
    [a.id],
  );
  assert.deepEqual(
    result.trail.map((film) => film.id),
    [b.id],
  );
  assert.deepEqual(
    result.batch.recommendations.map((rec) => rec.film.id),
    candidates.map((film) => film.id),
    "the curator ranking is not post-processed",
  );
  assert.ok(
    result.batch.recommendations.every(
      (rec) => RecommendationSchema.safeParse(rec).success,
    ),
  );
  assert.equal(
    result.batch.recommendations[0].connections[0].anchorId,
    a.id,
    "the cited anchor is presented first",
  );
  assert.equal(
    result.batch.recommendations[0].connections[0].relation,
    "direct_connection",
  );
  assert.deepEqual(result.batch.recommendations[0].sourceIds, ["context:p1"]);
  assert.equal(result.batch.recommendations[1].contextScope, "discovery");
  assert.equal(result.batch.recommendations[0].detailToken, "detail:tmdb:100");
  assert.equal(result.batch.sources.length, 1);
  assert.equal(result.batch.sources[0].excerpt, context.passages[0].excerpt);
});
