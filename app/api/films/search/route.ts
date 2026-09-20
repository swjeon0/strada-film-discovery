import { searchFilms } from "@/lib/server/metadata";
import { searchCollection } from "@/lib/catalogue";
import { errorResponse } from "@/lib/server/config";
export async function GET(r: Request) {
  try {
    const u = new URL(r.url);
    const q = (u.searchParams.get("q") ?? "").trim().slice(0, 100);
    const language = u.searchParams.get("language") === "ko" ? "ko" : "en";
    if (q.length < 2)
      return Response.json(
        { films: searchCollection(q) },
        { headers: { "Cache-Control": "no-store" } },
      );
    const external = await searchFilms(q, language, {
      remaining: 8,
      signal: r.signal,
    });
    const local = searchCollection(q);
    const films = [
      ...new Map([...local, ...external].map((f) => [f.id, f])).values(),
    ].slice(0, 8);
    return Response.json(
      { films },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
