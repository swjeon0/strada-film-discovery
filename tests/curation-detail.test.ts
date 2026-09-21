import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { type Film, type Recommendation, type Source } from "../lib/domain";
import {
  issueDetailToken,
  readDetailToken,
} from "../lib/server/curation-detail";
import { AppError } from "../lib/server/config";

const TEST_KEY = "strada-unit-test-signing-key-never-sent";
const selected: Film = {
  id: "tmdb:1",
  title: "Selected Film",
  titleKo: "선택한 영화",
  year: 1990,
  director: "Selected Director",
  poster: "",
};
const recommended: Film = {
  id: "tmdb:2",
  title: "Recommended Film",
  titleKo: "추천 영화",
  year: 2000,
  director: "Recommended Director",
  poster: "",
  overviewEn: "A film about a mountain journey.",
};
const rec: Recommendation = {
  film: recommended,
  connections: [
    {
      anchorId: selected.id,
      anchorTitle: selected.title,
      relation: "grounded_interpretation",
      why: "A specific proposed relationship.",
      sourceIds: ["s0"],
    },
  ],
  sourceIds: ["s0"],
  curation: {
    lens: "A formal question",
    bridge: "A concrete connection.",
    contrast: "A productive difference.",
  },
};
const source: Source = {
  id: "s0",
  title: "A verified essay",
  publisher: "Journal",
  author: "A critic",
  date: null,
  url: "https://example.org/essay",
  type: "criticism",
  scope: "Selected Film",
  summary: "What the exact passage supports.",
  excerpt: "The actual supplied passage.",
  accessLevel: "open",
  boundary: "This does not establish influence.",
  locator: "Page 3, paragraph 2",
};

function isolate(t: { after: (fn: () => void) => void }) {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = TEST_KEY;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Detail token tests must never access the network.");
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });
}
const isError = (code: string, status: number) => (error: unknown) =>
  error instanceof AppError && error.code === code && error.status === status;
function signed(packet: unknown) {
  const body = Buffer.from(JSON.stringify(packet)).toString("base64url");
  return (
    body +
    "." +
    createHmac("sha256", TEST_KEY)
      .update("strada-detail-v2:" + body)
      .digest("base64url")
  );
}
const token = () => issueDetailToken(rec, [selected], [source])!;

test("detail tokens retain verified identities and only evidence actually linked to the recommendation", (t) => {
  isolate(t);
  const issued = issueDetailToken(
    rec,
    [selected],
    [
      source,
      {
        ...source,
        id: "unlinked",
        excerpt: "Do not include this unrelated evidence.",
      },
    ],
  );
  assert.ok(issued);
  const packet = readDetailToken(issued);
  assert.equal(packet.version, 2);
  assert.equal(packet.film.id, recommended.id);
  assert.equal(
    packet.film.overview,
    recommended.overviewEn,
    "the recommended film’s own synopsis constrains expansion of the draft",
  );
  assert.equal(packet.selected[0].titleKo, selected.titleKo);
  assert.equal(packet.bridge, rec.curation?.bridge);
  assert.deepEqual(packet.evidence, [
    {
      title: source.title,
      author: source.author,
      publisher: source.publisher,
      scope: source.scope,
      url: source.url,
      excerpt: source.excerpt,
      point: source.summary,
      access: source.accessLevel,
      boundary: source.boundary,
      locator: source.locator,
      type: source.type,
    },
  ]);
  assert.equal("poster" in packet.film, false);
});

test("detail context keeps equally bounded film summaries and attributed source context", (t) => {
  isolate(t);
  const selectedFilms = Array.from({ length: 6 }, (_, index) => ({
    ...selected,
    id: `tmdb:${index + 10}`,
    overviewEn: `Film ${index}: ${"A specific piece of identity context. ".repeat(30)}`,
  }));
  const packet = readDetailToken(issueDetailToken(rec, selectedFilms, [source])!);
  assert.equal(packet.selected.length, 6);
  assert.ok(packet.selected.every((film) => film.overview?.length === 250));
  assert.equal(packet.evidence[0].author, source.author);
  assert.equal(packet.evidence[0].publisher, source.publisher);
  assert.equal(packet.evidence[0].scope, source.scope);
});

test("source-free interpretations receive valid detail tokens without invented citations", (t) => {
  isolate(t);
  const ai: Recommendation = {
    ...rec,
    sourceIds: [],
    connections: [
      { ...rec.connections[0], relation: "ai_inference", sourceIds: [] },
    ],
  };
  const issued = issueDetailToken(ai, [selected], [source]);
  assert.ok(issued);
  assert.deepEqual(readDetailToken(issued).evidence, []);
});

test("abstract-only papers are excluded and stale source versions cannot be expanded", (t) => {
  isolate(t);
  const abstract = {
    ...source,
    type: "academic" as const,
    accessLevel: "abstract",
  };
  assert.deepEqual(
    readDetailToken(issueDetailToken(rec, [selected], [abstract])!).evidence,
    [],
  );
  const removed = {
    ...source,
    documentId: "removed-document",
    documentVersion: "old-version",
  };
  const issued = issueDetailToken(rec, [selected], [removed])!;
  assert.throws(() => readDetailToken(issued), isError("DETAIL_EXPIRED", 410));
  assert.throws(
    () =>
      readDetailToken(issued, new Map([["removed-document", "new-version"]])),
    isError("DETAIL_EXPIRED", 410),
  );
  assert.equal(
    readDetailToken(issued, new Map([["removed-document", "old-version"]]))
      .evidence.length,
    1,
  );
});

test("authentic pre-corpus tokens require a refreshed recommendation", (t) => {
  isolate(t);
  const packet = { ...readDetailToken(token()), version: 1 },
    body = Buffer.from(JSON.stringify(packet)).toString("base64url");
  const legacy =
    body +
    "." +
    createHmac("sha256", TEST_KEY)
      .update("strada-detail-v1:" + body)
      .digest("base64url");
  assert.throws(() => readDetailToken(legacy), isError("DETAIL_EXPIRED", 410));
});

test("body tampering, changed signatures and malformed token structure are rejected", (t) => {
  isolate(t);
  const issued = token(),
    [body, signature] = issued.split(".");
  const packet = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  packet.film.title = "An injected new identity";
  const alteredBody = Buffer.from(JSON.stringify(packet)).toString("base64url");
  assert.throws(
    () => readDetailToken(alteredBody + "." + signature),
    isError("INVALID_INPUT", 400),
  );
  assert.throws(
    () =>
      readDetailToken(
        body + "." + (signature[0] === "x" ? "y" : "x") + signature.slice(1),
      ),
    isError("INVALID_INPUT", 400),
  );
  for (const invalid of ["", body, issued + ".extra", body + ".short"])
    assert.throws(
      () => readDetailToken(invalid),
      isError("INVALID_INPUT", 400),
    );
});

test("an authentic token expires after 30 days and timestamps far in the future are invalid", (t) => {
  isolate(t);
  const packet = readDetailToken(token());
  assert.throws(
    () =>
      readDetailToken(
        signed({ ...packet, issued: Date.now() - 31 * 86400_000 }),
      ),
    isError("DETAIL_EXPIRED", 410),
  );
  assert.throws(
    () => readDetailToken(signed({ ...packet, issued: Date.now() + 120_000 })),
    isError("DETAIL_EXPIRED", 410),
  );
  assert.equal(
    readDetailToken(signed({ ...packet, issued: Date.now() - 29 * 86400_000 }))
      .film.id,
    recommended.id,
  );
});

test("oversize token input is rejected before signature work and oversize valid packets are not issued", (t) => {
  isolate(t);
  assert.throws(
    () => readDetailToken("x".repeat(16001)),
    isError("INVALID_INPUT", 400),
  );
  const longSelected = Array.from({ length: 38 }, (_, i) => ({
    ...selected,
    id: `tmdb:${i + 100}`,
    title: "t".repeat(240),
    titleKo: "한".repeat(240),
    director: "d".repeat(240),
  }));
  assert.equal(issueDetailToken(rec, longSelected, [source]), undefined);
});

test("signed malformed payloads cannot bypass packet validation and signing key rotation invalidates old tokens", (t) => {
  isolate(t);
  const issued = token(),
    packet = readDetailToken(issued);
  assert.throws(
    () => readDetailToken(signed({ ...packet, version: 99 })),
    isError("INVALID_INPUT", 400),
  );
  assert.throws(
    () => readDetailToken(signed({ ...packet, selected: [] })),
    isError("INVALID_INPUT", 400),
  );
  assert.throws(
    () =>
      readDetailToken(
        signed({
          ...packet,
          evidence: [{ ...packet.evidence[0], url: "not-a-url" }],
        }),
      ),
    isError("INVALID_INPUT", 400),
  );
  process.env.OPENAI_API_KEY = "a-different-test-signing-key";
  assert.throws(() => readDetailToken(issued), isError("INVALID_INPUT", 400));
});
