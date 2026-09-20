import { getFilmDetails, getFilm } from "@/lib/server/metadata";
import { errorResponse } from "@/lib/server/config";
export async function GET(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const language =
      new URL(r.url).searchParams.get("language") === "ko" ? "ko" : "en";
    return Response.json(
      {
        film:
          new URL(r.url).searchParams.get("details") === "0"
            ? await getFilm(decodeURIComponent(id), {
                remaining: 8,
                signal: r.signal,
              })
            : await getFilmDetails(decodeURIComponent(id), language, {
                remaining: 8,
                signal: r.signal,
              }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
