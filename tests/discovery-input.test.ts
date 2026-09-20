import assert from "node:assert/strict";
import test from "node:test";
import { discoveryInput } from "../lib/client/discovery-input";
import {
  EMPTY_SESSION,
  commitSnapshot,
  type Film,
  type Snapshot,
} from "../lib/domain";

const film: Film = {
  id: "tmdb:1",
  title: "Film",
  year: 2000,
  director: "Director",
  poster: "",
};
const recommendation = (id: string) => ({
  film: { ...film, id },
  connections: [
    {
      anchorId: film.id,
      anchorTitle: film.title,
      relation: "ai_inference" as const,
      why: "A specific connection.",
      sourceIds: [],
    },
  ],
  sourceIds: [],
});

test("discovery request contains only current selection and explicit exclusion history", () => {
  const initial = discoveryInput(
    { ...EMPTY_SESSION, seedDraft: [film] },
    "ko",
    "initial",
  );
  assert.deepEqual(initial.seeds, [film.id]);
  assert.deepEqual(initial.trail, []);
  assert.deepEqual(initial.previousIds, []);
  const snapshot: Snapshot = {
    id: "one",
    createdAt: "2026-09-20T00:00:00.000Z",
    seeds: [film],
    trail: [],
    recommendations: Array.from({ length: 12 }, (_, index) =>
      recommendation(`tmdb:${index + 2}`),
    ),
    sources: [],
    mode: "live",
  };
  const session = commitSnapshot(EMPTY_SESSION, snapshot, true),
    next = { ...film, id: "tmdb:99" };
  const follow = discoveryInput(session, "en", "follow", next);
  assert.deepEqual(follow.seeds, [film.id]);
  assert.deepEqual(follow.trail, [next.id]);
  assert.deepEqual(
    follow.previousIds,
    snapshot.recommendations.map((item) => item.film.id),
  );
  assert.equal("preparationToken" in follow, false);
});
