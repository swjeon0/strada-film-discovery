import test from "node:test";
import assert from "node:assert/strict";
import {
  collection,
  filmById,
  recommendCollection,
  searchCollection,
} from "../lib/catalogue";
import {
  weights,
  commitSnapshot,
  restoreSnapshot,
  parseSession,
  EMPTY_SESSION,
  SnapshotSchema,
  type Snapshot,
} from "../lib/domain";
const film = (id: string) => filmById(id)!;
const snapshot = (id: string, trail: string[] = []): Snapshot =>
  SnapshotSchema.parse({
    id,
    createdAt: new Date().toISOString(),
    seeds: [film("closeup")],
    trail: trail.map(film),
    ...recommendCollection([film("closeup")], trail.map(film)),
  });
test("Korean titles, director and punctuation search resolve real films", () => {
  assert.equal(searchCollection("클로즈업")[0].id, "closeup");
  assert.ok(searchCollection("Kiarostami").length > 1);
  assert.equal(searchCollection("F for Fake")[0].id, "fake");
  assert.equal(searchCollection("no matching movie").length, 0);
});
test("starting and followed films have exactly equal influence", () => {
  const w = weights(
    [film("closeup"), film("fake")],
    [film("apple"), film("boards")],
  );
  assert.deepEqual(
    w.map((x) => x.weight),
    [0.25, 0.25, 0.25, 0.25],
  );
});
test("every starting point has grounded, unique, non-self recommendations", () => {
  for (const seed of collection) {
    const batch = recommendCollection([seed], []);
    assert.ok(batch.recommendations.length >= 3);
    assert.ok(batch.recommendations.length <= 12);
    const sources = new Set(batch.sources.map((s) => s.id));
    assert.equal(
      new Set(batch.recommendations.map((r) => r.film.id)).size,
      batch.recommendations.length,
    );
    for (const r of batch.recommendations) {
      assert.notEqual(r.film.id, seed.id);
      assert.ok(r.sourceIds.every((id) => sources.has(id)));
      assert.ok(
        r.connections.every(
          (c) =>
            c.anchorId === seed.id &&
            c.sourceIds.every((id) => sources.has(id)),
        ),
      );
    }
  }
});
test("follow excludes all selected films and changes the rank", () => {
  const a = recommendCollection([film("closeup")], []);
  const b = recommendCollection([film("closeup")], [film("apple")]);
  assert.ok(
    b.recommendations.every((r) => !["closeup", "apple"].includes(r.film.id)),
  );
  assert.notDeepEqual(
    a.recommendations.map((r) => r.film.id),
    b.recommendations.map((r) => r.film.id),
  );
});
test("undo restores the exact batch and evidence; successful branch replaces suffix only", () => {
  let s = commitSnapshot(EMPTY_SESSION, snapshot("zero"), true);
  s = commitSnapshot(s, snapshot("one", ["apple"]), false);
  s = commitSnapshot(s, snapshot("two", ["apple", "boards"]), false);
  const original = s.snapshots[0];
  s = restoreSnapshot(s, 0);
  assert.equal(s.snapshots[s.cursor], original);
  assert.equal(s.snapshots.length, 3);
  assert.throws(() =>
    commitSnapshot(s, { ...snapshot("bad"), recommendations: [] }, false),
  );
  assert.equal(s.snapshots.length, 3);
  s = commitSnapshot(s, snapshot("branch", ["fake"]), false);
  assert.deepEqual(
    s.snapshots.map((x) => x.id),
    ["zero", "branch"],
  );
  assert.deepEqual(
    parseSession(JSON.stringify(s)),
    JSON.parse(JSON.stringify(s)),
  );
});
test("invalid saved evidence and unknown restore targets are rejected", () => {
  const s = commitSnapshot(EMPTY_SESSION, snapshot("initial"), true);
  s.snapshots[0].recommendations[0].connections[0].sourceIds = ["missing"];
  assert.throws(() => parseSession(JSON.stringify(s)));
  assert.throws(() => restoreSnapshot(s, -1));
});
test("exhausted collection returns an honest empty batch", () => {
  const b = recommendCollection([collection[0]], collection.slice(1));
  assert.deepEqual(b.recommendations, []);
});

test("Korean display uses database labels and preserves a title when none exists", async () => {
  const { titleOf } = await import("../lib/domain");
  assert.equal(titleOf(film("closeup"), "ko"), "클로즈업");
  assert.equal(
    titleOf({ ...film("closeup"), titleKo: undefined }, "ko"),
    "Close-Up",
  );
});
test("additional, duplicate or unknown anchors earn no automatic relevance bonus", async () => {
  const { connectionScore } = await import("../lib/ranking");
  const template = recommendCollection([film("closeup")], [])
    .recommendations[0];
  const edge = template.connections[0];
  const one = { ...template, connections: [edge] };
  const duplicates = {
    ...template,
    connections: [edge, edge, { ...edge, anchorId: "unknown" }],
  };
  assert.equal(
    connectionScore(one, [film("closeup")], []),
    connectionScore(duplicates, [film("closeup")], []),
  );
  const two = {
    ...template,
    connections: [
      { ...edge, anchorId: "closeup", relation: "direct_connection" as const },
      { ...edge, anchorId: "fake", relation: "direct_connection" as const },
    ],
  };
  assert.equal(connectionScore(two, [film("closeup"), film("fake")], []), 1);
});
test("diversity changes the order of equally supported candidates without losing evidence", async () => {
  const { rankRecommendations } = await import("../lib/ranking");
  const template = recommendCollection([film("closeup")], [])
    .recommendations[0];
  const a = {
    ...template,
    film: {
      ...template.film,
      id: "a",
      director: "Director A",
      country: "Iran",
      year: 1990,
    },
  };
  const b = {
    ...template,
    film: {
      ...template.film,
      id: "b",
      director: "Director A",
      country: "Iran",
      year: 1991,
    },
  };
  const c = {
    ...template,
    film: {
      ...template.film,
      id: "c",
      director: "Director C",
      country: "Japan",
      year: 1960,
    },
  };
  const ranked = rankRecommendations([a, b, c], [film("closeup")], []);
  assert.deepEqual(
    ranked.map((r) => r.film.id),
    ["a", "c", "b"],
  );
  assert.equal(ranked[0].sourceIds, template.sourceIds);
});

import { titleMatches } from "../lib/server/film-identity";
import { RecommendationSchema, safePoster } from "../lib/domain";
test("AI-only recommendations persist honestly and cannot carry fabricated evidence", () => {
  const template = recommendCollection([film("closeup")], [])
    .recommendations[0];
  const ai = {
    ...template,
    sourceIds: [],
    connections: [
      { ...template.connections[0], relation: "ai_inference", sourceIds: [] },
    ],
  };
  assert.ok(RecommendationSchema.safeParse(ai).success);
  assert.equal(
    RecommendationSchema.safeParse({ ...ai, sourceIds: ["phantom"] }).success,
    false,
  );
  assert.equal(
    RecommendationSchema.safeParse({
      ...ai,
      connections: [{ ...ai.connections[0], sourceIds: ["phantom"] }],
    }).success,
    false,
  );
  assert.equal(
    RecommendationSchema.safeParse({
      ...ai,
      connections: [
        { ...ai.connections[0], relation: "grounded_interpretation" },
      ],
    }).success,
    false,
  );
  const state = commitSnapshot(
    EMPTY_SESSION,
    {
      ...snapshot("ai"),
      recommendations: [RecommendationSchema.parse(ai)],
      sources: [],
    },
    true,
  );
  assert.equal(
    parseSession(JSON.stringify(state)).snapshots[0].recommendations[0]
      .connections[0].relation,
    "ai_inference",
  );
});
test("poster proxy accepts only trusted image hosts and valid local poster paths", () => {
  assert.equal(
    safePoster("https://image.tmdb.org/t/p/w500/test.jpg"),
    "https://image.tmdb.org/t/p/w500/test.jpg",
  );
  for (const url of [
    "https://image.tmdb.org.evil.test/x",
    "http://image.tmdb.org/x",
    "https://x@image.tmdb.org/a",
    "https://image.tmdb.org:8080/a",
    "https://127.0.0.1/a",
    "/posters/../.env.local",
  ])
    assert.equal(safePoster(url), "");
});
test("film identity matching tolerates articles and punctuation", () => {
  assert.equal(titleMatches("Close-Up", "Close Up"), true);
  assert.equal(
    titleMatches("The Moment of Innocence", "A Moment of Innocence"),
    true,
  );
});
test("existing saved explanations clean serialization fragments without losing a trail", () => {
  const sn = snapshot("saved-bad-copy");
  sn.recommendations[0].connections[0].why =
    "Notice how everyday gestures reveal the passage of time.” },“inferenceWhyKo”:{ } , , , ,";
  const saved = parseSession(
    JSON.stringify(commitSnapshot(EMPTY_SESSION, sn, true)),
  );
  assert.equal(
    saved.snapshots[0].recommendations[0].connections[0].why,
    "Notice how everyday gestures reveal the passage of time.",
  );
  assert.equal(
    saved.snapshots[0].recommendations.length,
    sn.recommendations.length,
  );
});
