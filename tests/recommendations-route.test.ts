import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/recommendations/route";
import { collection } from "../lib/catalogue";

test("recommendation route streams actual stages and an exact twelve-film result, retaining JSON compatibility", async (t) => {
  const oldKey = process.env.OPENAI_API_KEY, oldFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "fixture-not-a-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
  let calls = 0;
  const candidates = collection.slice(1, 13);
  assert.equal(candidates.length, 12);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.stream, true);
    assert.equal(request.model, "gpt-5.6-terra");
    calls++;
    const output = JSON.stringify({
      v: "An invitation to explore distinct discoveries",
      r: candidates.map((film, index) => ({
        t: film.title, y: film.year, d: film.director, a: [0],
        b: `A precise connection for film ${index}`, e: [], k: "m",
      })),
    });
    const completed = {
      status: "completed", model: "fixture",
      output: [{ type: "message", content: [{ type: "output_text", text: output }] }],
    };
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < output.length; i += 31)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: output.slice(i, i + 31) })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  const body = { requestId: "route-fixture", baseSnapshotId: null, seeds: [collection[0].id], trail: [], language: "en" };
  const response = await POST(new Request("https://strada.example/api/recommendations", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify(body),
  }));
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  const stages = events.filter((event) => event.type === "progress").map((event) => event.stage);
  assert.ok(stages.includes("metadata"));
  assert.ok(stages.includes("context"));
  assert.ok(stages.includes("curating"));
  assert.ok(stages.includes("verifying"));
  const result = events.find((event) => event.type === "result");
  assert.ok(result, JSON.stringify(events));
  assert.equal(result.data.recommendations.length, 12);
  assert.equal(result.data.requestId, body.requestId);
  assert.deepEqual(result.data.recommendations.map((row: { film: { id: string } }) => row.film.id), candidates.map((film) => film.id));
  const json = await POST(new Request("https://strada.example/api/recommendations", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal(json.status, 200);
  assert.equal((await json.json()).recommendations.length, 12);
  assert.equal(calls, 1, "an identical JSON transport retry reuses the completed streamed run");
});

test("invalid recommendation input fails before opening a success stream", async () => {
  const response = await POST(new Request("https://strada.example/api/recommendations", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({ requestId: "invalid", baseSnapshotId: null, seeds: [], trail: [] }),
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_INPUT");
});
