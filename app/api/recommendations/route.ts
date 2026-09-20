import { RecommendationInput } from "@/lib/server/recommendation-input";
import { checkOrigin, errorResponse, AppError } from "@/lib/server/config";
import { runCuratorProduction } from "@/lib/server/curator/production";
import { readLimitedJson } from "@/lib/server/request";
export const runtime = "nodejs";
export const maxDuration = 30;
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
    const result = await runCuratorProduction(x, r.signal);
    return Response.json(
      {
        ...result.batch,
        timings: result.timings,
        diagnostics: result.diagnostics,
        seeds: result.seeds,
        trail: result.trail,
        requestId: x.requestId,
        baseSnapshotId: x.baseSnapshotId,
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SyntaxError)
      return errorResponse(
        new AppError("INVALID_INPUT", "The request could not be read.", 400),
      );
    return errorResponse(e);
  }
}
