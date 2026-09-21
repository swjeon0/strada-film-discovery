import assert from "node:assert/strict";
import test from "node:test";
import { proposalObserver, readResponsesStream } from "../lib/server/curator/response-stream";
import { createResolutionSession } from "../lib/server/curator/resolve";
import { CuratorRequestCache } from "../lib/server/curator/request-cache";
import { runCurator } from "../lib/server/curator/engine";
import type { CuratorOutput } from "../lib/server/curator/contract";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("proposal observer reads complete rows across arbitrary JSON chunks exactly once", () => {
  const seen: unknown[] = [], observe = proposalObserver((row) => seen.push(row));
  const row = { t: 'A "quoted" [film]', y: 1990, d: "Director", a: [0], b: "A string with {braces}.", e: [], k: "m" };
  const json = JSON.stringify({ v: "An invitation", r: [row, { ...row, t: "다른 영화" }] });
  for (let index = 0; index < json.length; index += 3) observe(json.slice(index, index + 3));
  assert.deepEqual(seen, [
    { title: row.t, year: row.y, director: row.d },
    { title: "다른 영화", year: row.y, director: row.d },
  ]);
});

test("SSE parser preserves split UTF8 and reads terminal usage; incomplete streams fail", async () => {
  const encoder = new TextEncoder(), text: string[] = [];
  const content = [
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"영화"}\r\n\r\n',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":12}}}\n\n',
  ].join("");
  const bytes = encoder.encode(content);
  const response = new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
    controller.close();
  } }));
  assert.deepEqual(await readResponsesStream(response, new AbortController().signal, (delta) => text.push(delta)), {
    status: "completed", usage: { output_tokens: 12 },
  });
  assert.deepEqual(text, ["영화"]);
  await assert.rejects(() => readResponsesStream(new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'), new AbortController().signal, () => {}), /ended before completion/);
});

test("identity session bounds concurrency and reuses all unchanged identities on repair", async () => {
  let active = 0, peak = 0, calls = 0;
  const session = createResolutionSession(new AbortController().signal, async (rows) => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return rows.map((row) => ({ ...row, id: `film:${row.title}`, poster: "" }));
  });
  const rows = Array.from({ length: 12 }, (_, i) => ({ title: `Film ${i}`, year: 2000 + i, director: "Director" }));
  for (const row of rows) session.warm(row);
  const first = await session.resolve(rows, { remaining: 80 });
  const repaired = await session.resolve([...rows.slice(0, 11), { ...rows[11], title: "Replacement" }], { remaining: 80 });
  assert.equal(calls, 13);
  assert.equal(peak, 4);
  assert.deepEqual(first.slice(0, 11), repaired.slice(0, 11));
});

test("engine overlaps verified identity work with generation and preserves twelve-film ranking", async () => {
  const firstIdentity = deferred<void>();
  let modelFinished = false, overlap = false;
  const selected = [{ id: "tmdb:1", title: "Input", year: 2000, director: "Director", poster: "" }];
  const output: CuratorOutput = {
    lens: "Several discoveries", description: "Several discoveries",
    recommendations: Array.from({ length: 12 }, (_, i) => ({
      title: `Film ${i}`, year: 1950 + i, director: "Director", anchorIds: [selected[0].id],
      connection: `Specific observation ${i}`, evidenceIds: [], attribution: "model_proposal",
    })),
  };
  const result = await runCurator({
    selected, excludedIds: [], language: "en", signal: new AbortController().signal,
    repository: { fingerprint: () => "fixture", buildContext: async () => ({ version: 1, corpusVersion: "fixture", builtAt: new Date().toISOString(), selectedFilmIds: [selected[0].id], passages: [], legacyNotes: [] }) },
    options: { model: "unchanged-model", reasoning: "none", timeoutMs: 500, maxOutputTokens: 2000 },
  }, { curate: async (_request, _options, _signal, _fetch, onProposal) => {
    onProposal?.(output.recommendations[0]);
    await firstIdentity.promise;
    modelFinished = true;
    for (const row of output.recommendations.slice(1)) onProposal?.(row);
    return { output, model: "unchanged-model", elapsedMs: 1, usage: { model: "unchanged-model", inputTokens: 1, outputTokens: 1, searchCalls: 0, estimatedUsd: 0 } };
  } }, async (rows) => {
    if (!modelFinished) { overlap = true; firstIdentity.resolve(); }
    return rows.map((row) => ({ ...row, id: `film:${row.title}`, poster: "" }));
  });
  assert.ok(overlap);
  assert.equal(result.decision.recommendations.length, 12);
  assert.deepEqual(result.decision.recommendations.map((row) => row.film.title), output.recommendations.map((row) => row.title));
});

test("transport retry shares in-flight and completed requests while regeneration gets fresh work", async () => {
  const cache = new CuratorRequestCache<number, string>(), gate = deferred<number>();
  let calls = 0;
  const execute = async (_signal: AbortSignal, emit: (stage: string) => void) => { calls++; emit("curating"); return gate.promise; };
  const firstController = new AbortController(), first = cache.run("same-request", firstController.signal, execute);
  const rejected = assert.rejects(first, (error) => error instanceof DOMException && error.name === "AbortError");
  await Promise.resolve();
  firstController.abort();
  const stages: string[] = [];
  const reconnected = cache.run("same-request", new AbortController().signal, execute, (stage) => stages.push(stage));
  gate.resolve(12);
  await rejected;
  assert.equal(await reconnected, 12);
  assert.deepEqual(stages, ["curating"]);
  assert.equal(await cache.run("same-request", new AbortController().signal, execute), 12);
  assert.equal(calls, 1);
  assert.equal(await cache.run("new-request", new AbortController().signal, execute), 12);
  assert.equal(calls, 2);
});

test("canceling one subscriber does not cancel another and failed work is not cached", async () => {
  const cache = new CuratorRequestCache<number, string>(), gate = deferred<number>();
  let sharedSignal: AbortSignal | undefined;
  const execute = async (signal: AbortSignal) => { sharedSignal = signal; return gate.promise; };
  const firstController = new AbortController();
  const first = cache.run("a", firstController.signal, execute);
  const second = cache.run("a", new AbortController().signal, execute);
  const canceled = assert.rejects(first);
  await Promise.resolve();
  firstController.abort();
  assert.equal(sharedSignal?.aborted, false);
  gate.resolve(12);
  await canceled;
  assert.equal(await second, 12);
  await assert.rejects(cache.run("failure", new AbortController().signal, async () => { throw new Error("transient"); }));
  assert.equal(await cache.run("failure", new AbortController().signal, async () => 12), 12);
});

test("host retention waits for existing work without keeping abandoned model work alive", async () => {
  const cache = new CuratorRequestCache<number, string>(60_000, 32, 2);
  const controller = new AbortController();
  let calls = 0, aborted = false;
  const first = cache.run("host-retained", controller.signal, async (signal) => {
    calls++;
    return new Promise<number>((_resolve, reject) => signal.addEventListener("abort", () => {
      aborted = true;
      reject(signal.reason);
    }, { once: true }));
  });
  const canceled = assert.rejects(first), retention = cache.settlement("host-retained");
  await Promise.resolve();
  controller.abort();
  await canceled;
  assert.equal(aborted, false, "the reconnect grace window remains available");
  const keepTestAlive = setTimeout(() => {}, 100);
  try { await retention; } finally { clearTimeout(keepTestAlive); }
  assert.equal(aborted, true, "host retention is not another waiting client");
  assert.equal(calls, 1);
  await cache.settlement("missing");
  assert.equal(calls, 1, "retention never starts another call");
});
