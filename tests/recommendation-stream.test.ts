import test from "node:test";
import assert from "node:assert/strict";
import { readRecommendationResponse, requestRecommendations, RecommendationRequestError } from "../lib/client/recommendation-stream";

function stream(parts: string[]) {
  const bytes = new TextEncoder().encode(parts.join(""));
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 7));
      offset += 7;
    },
  }), { headers: { "content-type": "application/x-ndjson" } });
}
test("progress streams handle arbitrary UTF-8 chunk boundaries and complete result", async () => {
  const progress: string[] = [];
  const result = await readRecommendationResponse(stream([
    '{"type":"progress","stage":"curating"}\n',
    '{"type":"heartbeat"}\n',
    '{"type":"result","data":{"title":"만춘","count":12}}\n',
  ]), next => progress.push(next.stage));
  assert.deepEqual(progress, ["curating"]);
  assert.deepEqual(result, { title: "만춘", count: 12 });
});
test("an interrupted response is never committed as a smaller recommendation list", async () => {
  await assert.rejects(readRecommendationResponse(stream(['{"type":"progress","stage":"verifying"}\n']), () => {}),
    (error: unknown) => error instanceof RecommendationRequestError && error.code === "INCOMPLETE");
});
test("streamed server errors retain localized error codes", async () => {
  await assert.rejects(readRecommendationResponse(stream(['{"type":"error","error":{"code":"RATE_LIMIT"}}\n']), () => {}),
    (error: unknown) => error instanceof RecommendationRequestError && error.code === "RATE_LIMIT");
});
test("JSON responses remain compatible and final unterminated stream row is supported", async () => {
  assert.deepEqual(await readRecommendationResponse(Response.json({ count: 12 }), () => {}), { count: 12 });
  assert.deepEqual(await readRecommendationResponse(stream(['{"type":"result","data":{"count":12}}']), () => {}), { count: 12 });
});
test("one transport reconnect preserves the identical request rather than generating a new path", async () => {
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return stream(['{"type":"progress","stage":"curating"}\n']);
    return Response.json({ count: 12 });
  };
  assert.deepEqual(await requestRecommendations({ requestId: "same-id", baseSnapshotId: "B" }, new AbortController().signal, () => {}, fetcher), { count: 12 });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});
test("explicit cancellation and upstream model errors are not retried", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ error: { code: "RATE_LIMIT" } }, { status: 429 }); };
  await assert.rejects(requestRecommendations({}, new AbortController().signal, () => {}, fetcher));
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestRecommendations({}, controller.signal, () => {}, fetcher));
  assert.equal(calls, 1);
});

test("HTML gateway timeout reconnects while permanent HTML denial does not", async () => {
  let calls = 0;
  const transient: typeof fetch = async () => ++calls === 1
    ? new Response("Gateway timed out", { status: 504 }) : Response.json({ count: 12 });
  assert.deepEqual(await requestRecommendations({}, new AbortController().signal, () => {}, transient), { count: 12 });
  assert.equal(calls, 2);
  calls = 0;
  const permanent: typeof fetch = async () => { calls++; return new Response("Forbidden", { status: 403 }); };
  await assert.rejects(requestRecommendations({}, new AbortController().signal, () => {}, permanent));
  assert.equal(calls, 1);
});
