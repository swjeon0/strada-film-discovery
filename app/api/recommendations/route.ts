import { RecommendationInput } from "@/lib/server/recommendation-input";
import { checkOrigin, errorResponse, AppError } from "@/lib/server/config";
import { runCuratorProduction } from "@/lib/server/curator/production";
import { readLimitedJson } from "@/lib/server/request";
import { createHash } from "node:crypto";
import { CuratorRequestCache } from "@/lib/server/curator/request-cache";
import type { CuratorProgress } from "@/lib/server/curator/engine";
import { after } from "next/server";
export const runtime = "nodejs";
export const maxDuration = 60;
const requests = new CuratorRequestCache<Awaited<ReturnType<typeof runCuratorProduction>>, CuratorProgress>();
export async function POST(r: Request) {
  try {
    checkOrigin(r);
    const parsed = RecommendationInput.safeParse(
      await readLimitedJson(r, 2097152),
    );
    if (!parsed.success)
      throw new AppError(
        "INVALID_INPUT",
        "Choose between one and eight starting films.",
        400,
      );
    const x = parsed.data;
    if (
      new Set([...x.seeds, ...x.trail]).size !==
      x.seeds.length + x.trail.length
    )
      throw new AppError(
        "DUPLICATE_FILM",
        "A film can appear in your trail only once.",
        400,
      );
    const key = createHash("sha256").update(JSON.stringify(x)).digest("hex");
    const run = (signal: AbortSignal, onProgress?: (p: CuratorProgress) => void) => {
      const result = requests.run(key, signal, (sharedSignal, emit) =>
        runCuratorProduction(x, sharedSignal, {}, emit), onProgress);
      // Vercel cancellation may suspend the invocation as soon as its stream
      // disconnects. Retain the existing job through the short reconnect grace
      // window; a normal local Node process does not require host retention.
      if (process.env.VERCEL === "1") {
        const settled = requests.settlement(key);
        after(() => settled);
      }
      return result;
    };
    const payload = (result: Awaited<ReturnType<typeof runCuratorProduction>>) => ({
        ...result.batch,
        timings: result.timings,
        diagnostics: result.diagnostics,
        seeds: result.seeds,
        trail: result.trail,
        requestId: x.requestId,
        baseSnapshotId: x.baseSnapshotId,
        generatedAt: new Date().toISOString(),
      });
    if (!r.headers.get("accept")?.includes("application/x-ndjson"))
      return Response.json(payload(await run(r.signal)), {
        headers: { "Cache-Control": "no-store" },
      });
    const cancel = new AbortController(), signal = AbortSignal.any([r.signal, cancel.signal]);
    const encoder = new TextEncoder(), started = Date.now();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (value: unknown) => {
          if (!closed && !signal.aborted)
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        let latest: CuratorProgress = { stage: "metadata" };
        const progress = (value: CuratorProgress) => {
          latest = value;
          send({ type: "progress", ...value, elapsedMs: Date.now() - started });
        };
        progress(latest);
        const heartbeat = setInterval(() => progress(latest), 5000);
        try {
          send({ type: "result", data: payload(await run(signal, progress)) });
        } catch (error) {
          const body = await errorResponse(error).json();
          send({ type: "error", error: body.error });
        } finally {
          clearInterval(heartbeat);
          if (!closed) { closed = true; controller.close(); }
        }
      },
      cancel() { closed = true; cancel.abort(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    } });
  } catch (e) {
    if (e instanceof SyntaxError)
      return errorResponse(
        new AppError("INVALID_INPUT", "The request could not be read.", 400),
      );
    return errorResponse(e);
  }
}
