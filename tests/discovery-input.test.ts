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

test("A-B-C can branch at B and repairs stale browser history of C", async () => {
  const { restoreSnapshot } = await import("../lib/domain");
  const { resolveTrailNavigation } = await import("../lib/client/trail-navigation");
  const make = (id: string, trail: Film[], offset: number): Snapshot => ({
    id, createdAt: new Date().toISOString(), seeds: [film], trail,
    recommendations: Array.from({ length: 12 }, (_, n) => recommendation(`tmdb:${offset + n}`)),
    sources: [], mode: "live",
  });
  const b = { ...film, id: "tmdb:20" }, c = { ...film, id: "tmdb:40" }, next = { ...film, id: "tmdb:21" };
  let session = commitSnapshot(EMPTY_SESSION, make("A", [], 20), true);
  session = commitSnapshot(session, make("B", [b], 40), false);
  session = commitSnapshot(session, make("C", [b, c], 60), false);
  session = restoreSnapshot(session, 1);
  const request = discoveryInput(session, "en", "manual", next);
  assert.equal(request.baseSnapshotId, "B");
  assert.deepEqual(request.trail, [b.id, next.id]);
  session = commitSnapshot(session, make("C-prime", [b, next], 80), false);
  assert.deepEqual(session.snapshots.map(sn => sn.id), ["A", "B", "C-prime"]);
  assert.ok(session.archivedSeenIds?.includes("tmdb:60"));
  const restored = resolveTrailNavigation(session, { strada: true, view: "results", snapshotId: "C", filmId: "tmdb:60" });
  assert.equal(restored.nav.snapshotId, "C-prime");
  assert.equal(restored.nav.filmId, undefined);
  const again = resolveTrailNavigation(session, { strada: true, view: "results", snapshotId: "B", filmId: "tmdb:41" });
  assert.equal(again.session.cursor, 1);
  assert.equal(again.nav.filmId, "tmdb:41");
});
