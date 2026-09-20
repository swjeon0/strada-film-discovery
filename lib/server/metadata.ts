import { RECOMMENDATION_COUNT } from "./recommendation-input";
import { titleMatches } from "./film-identity";
import { config, AppError } from "./config";
import {
  getFilm as getTmdb,
  searchTMDB,
  resolveCandidate as resolveTmdb,
  type Budget,
} from "./tmdb";
import {
  getWikimediaFilm,
  getWikimediaFilms,
  searchWikimedia,
  enrichWikipedia,
  resolveWikimediaCandidate,
} from "./wikimedia";
import { filmById, collection } from "../catalogue";
import type { Film, Language } from "../domain";
export function canonicalFilm(film: Film) {
  return (
    collection.find((f) => f.wikidataId && f.wikidataId === film.wikidataId) ??
    film
  );
}
export async function searchFilms(
  query: string,
  language: Language,
  budget?: Budget,
) {
  const found = config().tmdb
    ? await searchTMDB(query, budget, language)
    : await searchWikimedia(query, language, budget);
  return [
    ...new Map(
      found.map((f) => {
        const c = canonicalFilm(f);
        return [c.id, c];
      }),
    ).values(),
  ];
}
export async function getFilm(id: string, budget?: Budget): Promise<Film> {
  const known = filmById(id);
  if (known) return known;
  if (id.startsWith("wd:"))
    return canonicalFilm(await getWikimediaFilm(id, budget));
  if (id.startsWith("tmdb:")) return getTmdb(id, budget);
  throw new AppError("INVALID_FILM", "This film could not be identified.", 400);
}
export async function getFilms(ids: string[], budget?: Budget) {
  const wd = ids.filter((id) => id.startsWith("wd:"));
  const wikidata = wd.length ? await getWikimediaFilms(wd, budget) : [];
  return mapLimited(ids, 4, async (id) =>
    id.startsWith("wd:")
      ? canonicalFilm(wikidata.find((f) => f.id === id)!)
      : await getFilm(id, budget),
  );
}
export async function getFilmDetails(
  id: string,
  language: Language,
  budget?: Budget,
) {
  const film = await getFilm(id, budget);
  if (film.wikidataId) {
    const enriched = await enrichWikipedia(film, language, budget);
    return enriched;
  }
  return film;
}
export async function resolveCandidate(
  title: string,
  year: number,
  director: string,
  budget: Budget,
) {
  const local = collection.find(
    (f) =>
      titleMatches(f.title, title) &&
      Math.abs(f.year - year) <= 1 &&
      directorMatches(f.director, director),
  );
  if (local) return local;
  return canonicalNullable(
    config().tmdb
      ? await resolveTmdb(title, year, director, budget)
      : await resolveWikimediaCandidate(title, year, director, budget),
  );
}
function canonicalNullable(f: Film | null) {
  return f ? canonicalFilm(f) : null;
}

export async function resolveCandidates(
  candidates: { title: string; year: number; director: string }[],
  budget: Budget,
) {
  const { wikiApi, filmsFromQids } = await import("./wikimedia");
  const found = new Map<number, Film>();
  const pending: number[] = [];
  for (const [i, c] of candidates.entries()) {
    const local = collection.find(
      (f) =>
        titleMatches(f.title, c.title) &&
        Math.abs(f.year - c.year) <= 1 &&
        directorMatches(f.director, c.director),
    );
    if (local) found.set(i, local);
    else pending.push(i);
  }
  if (!pending.length) return candidates.map((_, i) => found.get(i) ?? null);
  if (config().tmdb) {
    const failures: unknown[] = [];
    await mapLimited(pending, 3, async (i) => {
      try {
        const film = await resolveCandidate(
          candidates[i].title,
          candidates[i].year,
          candidates[i].director,
          budget,
        );
        if (film) found.set(i, film);
      } catch (error) {
        failures.push(error);
      }
    });
    if (!found.size && failures.length) throw failures[0];
  } else {
    try {
      const titles = [
        ...new Set(
          pending.flatMap((i) => [
            candidates[i].title,
            `${candidates[i].title} (${candidates[i].year} film)`,
            `${candidates[i].title} (film)`,
          ]),
        ),
      ].slice(0, 50);
      const data = await wikiApi(
        "en.wikipedia.org",
        {
          action: "query",
          titles: titles.join("|"),
          redirects: "1",
          prop: "pageprops",
          ppprop: "wikibase_item",
        },
        budget,
      );
      const pages = (data.query?.pages ?? []) as {
        pageprops?: { wikibase_item?: string };
      }[];
      const qids = [
        ...new Set(
          pages.flatMap((page) =>
            page.pageprops?.wikibase_item ? [page.pageprops.wikibase_item] : [],
          ),
        ),
      ];
      const movies = await filmsFromQids(qids, budget);
      for (const i of pending) {
        const c = candidates[i];
        const hits = movies.filter(
          (f) =>
            [
              f.title,
              f.originalTitle ?? "",
              ...(f.aliases ?? []),
              f.wikiEn?.replace(/\s*\([^)]*film[^)]*\)$/i, "") ?? "",
            ].some((title) => titleMatches(title, c.title)) &&
            Math.abs(f.year - c.year) <= 1 &&
            f.director
              .split(",")
              .some((d) => normalizeName(d) === normalizeName(c.director)),
        );
        if (hits.length === 1) {
          const film = canonicalFilm(hits[0]);
          found.set(i, film);
        }
      }
    } catch {}
    // A few unusual database aliases may need the broader Wikidata title search.
    const unresolved = pending.filter((i) => !found.has(i));
    if (
      new Set([...found.values()].map((f) => f.id)).size < RECOMMENDATION_COUNT
    )
      await mapLimited(unresolved.slice(0, 6), 2, async (i) => {
        if (budget.remaining < 4) return;
        try {
          const f = await resolveCandidate(
            candidates[i].title,
            candidates[i].year,
            candidates[i].director,
            budget,
          );
          if (f) found.set(i, f);
        } catch {}
      });
  }
  return candidates.map((_, i) => found.get(i) ?? null);
}
function normalizeName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}
function personTokens(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).sort();
}
export function directorMatches(a: string, b: string) {
  const left = personTokens(a),
    right = personTokens(b);
  return (
    left.length > 0 &&
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        result[i] = await fn(items[i], i);
      }
    }),
  );
  return result;
}
