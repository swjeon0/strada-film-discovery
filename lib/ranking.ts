import type { Film, Recommendation } from "./domain";
export function connectionScore(
  rec: Recommendation,
  seeds: Film[],
  trail: Film[],
) {
  // Legacy collection ordering only. Neither citation labels nor the number of
  // links can measure the quality of a curatorial interpretation.
  const selected = new Set([...seeds, ...trail].map((film) => film.id));
  return rec.connections.some((connection) => selected.has(connection.anchorId))
    ? 1
    : 0;
}
function similarity(a: Film, b: Film) {
  let score = 0;
  if (a.director && a.director === b.director) score += 0.45;
  if (a.country && a.country === b.country) score += 0.2;
  if (Math.floor(a.year / 10) === Math.floor(b.year / 10)) score += 0.15;
  if (a.genres?.some((g) => b.genres?.includes(g))) score += 0.2;
  return score;
}
export function rankRecommendations(
  recs: Recommendation[],
  seeds: Film[],
  trail: Film[],
  seenIds: string[] = [],
  limit = 12,
) {
  const excluded = new Set([...seeds, ...trail].map((f) => f.id));
  const unique = [
    ...new Map(
      recs.filter((r) => !excluded.has(r.film.id)).map((r) => [r.film.id, r]),
    ).values(),
  ];
  const base = new Map(
    unique.map((r) => [r.film.id, connectionScore(r, seeds, trail)]),
  );
  const max = Math.max(...base.values(), 0.0001);
  const seen = new Set(seenIds);
  const chosen: Recommendation[] = [];
  while (unique.length && chosen.length < limit) {
    unique.sort((a, b) => {
      const value = (r: Recommendation) => {
        const relevance = (base.get(r.film.id) ?? 0) / max;
        const redundancy = chosen.length
          ? Math.max(...chosen.map((s) => similarity(r.film, s.film)))
          : 0;
        return (
          relevance * (1 - 0.22 * redundancy) -
          (seen.has(r.film.id) ? 0.025 : 0)
        );
      };
      return value(b) - value(a) || a.film.id.localeCompare(b.film.id);
    });
    chosen.push(unique.shift()!);
  }
  return chosen;
}
