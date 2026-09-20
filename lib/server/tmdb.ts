import { directorMatches, titleMatches } from "./film-identity";
import { config, AppError } from "./config";
import { filmById, collection } from "../catalogue";
import type { Film, Language } from "../domain";
const cache = new Map<string, { at: number; value: unknown }>();
export type Budget = { remaining: number; signal?: AbortSignal };
type TmdbMovie = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
};
type TmdbCrew = { job?: string; name?: string };
type TmdbMovieCredit = TmdbMovie & { job?: string };
type TmdbMovieDetail = TmdbMovie & {
  original_language?: string;
  overview?: string;
  runtime?: number;
  credits?: { crew?: TmdbCrew[] };
  translations?: {
    translations?: {
      iso_639_1?: string;
      data?: { title?: string; overview?: string };
    }[];
  };
  alternative_titles?: { titles?: { title?: string }[] };
  genres?: { id: number | string }[];
  production_countries?: { name?: string }[];
};
type TmdbPerson = { id: number; name?: string };
type TmdbSearch<T> = { results?: T[] };
type TmdbCredits = { crew?: TmdbMovieCredit[] };
const TMDB_RETRY_CAP_MS = 300,
  TMDB_RETRY_DEFAULT_MS = 75;
export function tmdbRetryDelayMs(value: string | null, now = Date.now()) {
  const seconds =
    value !== null && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value) * 1000
      : NaN;
  const dateMs =
    value !== null && !Number.isFinite(seconds) ? Date.parse(value) - now : NaN;
  const requested = Number.isFinite(seconds)
    ? seconds
    : Number.isFinite(dateMs)
      ? dateMs
      : TMDB_RETRY_DEFAULT_MS;
  return Math.max(0, Math.min(TMDB_RETRY_CAP_MS, requested));
}
function retryableStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599);
}
function transientFetchError(error: unknown) {
  return error instanceof TypeError;
}
function retryPause(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
export async function tmdb<T = unknown>(
  path: string,
  budget?: Budget,
): Promise<T> {
  const cached = cache.get(path);
  if (cached && Date.now() - cached.at < 600_000) return cached.value as T;
  const token = config().tmdb;
  if (!token)
    throw new AppError(
      "SETUP_REQUIRED",
      "Live movie search is not connected. The reference collection is available.",
      503,
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    if (budget && budget.remaining-- <= 0)
      throw new AppError(
        "BUDGET",
        "This trail needs more research than one request allows. Try fewer starting films.",
      );
    let res: Response;
    try {
      res = await fetch(`https://api.themoviedb.org/3${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal: budget?.signal
          ? AbortSignal.any([budget.signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      });
    } catch (error) {
      if (
        attempt === 0 &&
        !budget?.signal?.aborted &&
        transientFetchError(error)
      ) {
        await retryPause(TMDB_RETRY_DEFAULT_MS, budget?.signal);
        continue;
      }
      throw error;
    }
    if (!res.ok) {
      if (attempt === 0 && retryableStatus(res.status)) {
        const delay = tmdbRetryDelayMs(res.headers.get("retry-after"));
        await res.body?.cancel();
        await retryPause(delay, budget?.signal);
        continue;
      }
      throw new AppError(
        res.status === 429 ? "RATE_LIMIT" : "METADATA_ERROR",
        res.status === 429
          ? "Film search is busy. Please try again shortly."
          : "Film search is temporarily unavailable.",
        res.status === 429 ? 429 : 502,
      );
    }
    const value = (await res.json()) as T;
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(path, { at: Date.now(), value });
    return value;
  }
  throw new AppError(
    "METADATA_ERROR",
    "Film search is temporarily unavailable.",
    502,
  );
}
function basic(r: TmdbMovie): Film {
  return {
    id: `tmdb:${r.id}`,
    title: r.title || r.original_title || "",
    originalTitle: r.original_title || undefined,
    year: Number(r.release_date?.slice(0, 4)) || 1900,
    director: "",
    poster: r.poster_path
      ? `https://image.tmdb.org/t/p/w500${r.poster_path}`
      : "",
  };
}
export async function searchTMDB(
  query: string,
  budget?: Budget,
  language: Language = "en",
) {
  const data = await tmdb<TmdbSearch<TmdbMovie>>(
    `/search/movie?query=${encodeURIComponent(query)}&include_adult=false&language=${language === "ko" ? "ko-KR" : "en-US"}&page=1`,
    budget,
  );
  return (data.results ?? [])
    .filter((film) => film.release_date && film.title)
    .slice(0, 8)
    .map((row) =>
      language === "ko"
        ? {
            ...basic(row),
            title: row.original_title || row.title || "",
            titleKo: row.title,
          }
        : basic(row),
    ) as Film[];
}
export async function getFilm(id: string, budget?: Budget): Promise<Film> {
  const local = filmById(id);
  if (local) return local;
  if (!/^tmdb:[1-9]\d*$/.test(id))
    throw new AppError(
      "INVALID_FILM",
      "This film could not be identified.",
      400,
    );
  const data = await tmdb<TmdbMovieDetail>(
    `/movie/${id.slice(5)}?append_to_response=credits,translations,alternative_titles`,
    budget,
  );
  const directors = (data.credits?.crew ?? [])
    .filter((row) => row.job === "Director" && row.name)
    .map((row) => row.name!);
  const ko = (data.translations?.translations ?? []).find(
    (row) => row.iso_639_1 === "ko",
  )?.data;
  const titleKo =
    ko?.title ||
    (data.original_language === "ko" ? data.original_title : undefined) ||
    undefined;
  const aliases = [
    ...new Set(
      (data.alternative_titles?.titles ?? [])
        .map((row) => String(row.title ?? "").trim())
        .filter(Boolean),
    ),
  ].slice(0, 80);
  const full: Film = {
    ...basic(data),
    originalTitle: data.original_title,
    ...(aliases.length ? { aliases } : {}),
    titleKo,
    titleKoSource: titleKo
      ? `https://www.themoviedb.org/movie/${id.slice(5)}`
      : undefined,
    overviewEn: data.overview || undefined,
    synopsisEn: data.overview || undefined,
    overviewKo: ko?.overview || undefined,
    synopsisKo: ko?.overview || undefined,
    synopsisEnSource: `https://www.themoviedb.org/movie/${id.slice(5)}`,
    synopsisKoSource: ko?.overview
      ? `https://www.themoviedb.org/movie/${id.slice(5)}`
      : undefined,
    genres: (data.genres ?? []).map((genre) => String(genre.id)),
    director: directors.join(", "),
    runtime: data.runtime,
    country: (data.production_countries ?? [])
      .map((country) => country.name)
      .filter(Boolean)
      .join(" / "),
  };
  return (
    collection.find(
      (film) =>
        norm(film.title) === norm(full.title) &&
        film.year === full.year &&
        norm(film.director) === norm(full.director),
    ) ?? full
  );
}
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\p{M}\p{P}\s]/gu, "");
const personTokens = (s: string) =>
  (
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).sort();
function samePerson(a: string, b: string) {
  const left = personTokens(a),
    right = personTokens(b);
  return (
    left.length > 0 &&
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}
const RESOLUTION_YEAR_TOLERANCE = 4;
function movieTitleMatches(
  row: {
    title?: string;
    original_title?: string;
    originalTitle?: string;
    aliases?: string[];
  },
  title: string,
) {
  return [
    row.title,
    row.original_title,
    row.originalTitle,
    ...(row.aliases ?? []),
  ].some((value) => typeof value === "string" && titleMatches(value, title));
}
function directedBy(film: Film, director: string) {
  return directorMatches(film.director, director);
}
async function resolveFromDirectorCredits(
  title: string,
  year: number,
  director: string,
  budget: Budget,
): Promise<Film | null> {
  const people = await tmdb<TmdbSearch<TmdbPerson>>(
    `/search/person?query=${encodeURIComponent(director)}&include_adult=false&language=en-US&page=1`,
    budget,
  );
  const exactPeople = (people.results ?? [])
    .filter(
      (person) =>
        Number.isInteger(person.id) &&
        samePerson(String(person.name ?? ""), director),
    )
    .slice(0, 3);
  if (!exactPeople.length) return null;
  const credits = (
    await Promise.all(
      exactPeople.map(
        async (person) =>
          (
            await tmdb<TmdbCredits>(
              `/person/${person.id}/movie_credits?language=en-US`,
              budget,
            )
          ).crew ?? [],
      ),
    )
  ).flat();
  const nearYear = credits.filter(
    (credit) =>
      credit.job === "Director" &&
      Number.isInteger(credit.id) &&
      credit.release_date &&
      Math.abs(Number(credit.release_date.slice(0, 4)) - year) <=
        RESOLUTION_YEAR_TOLERANCE,
  );
  const titled = nearYear.filter((credit) => movieTitleMatches(credit, title)),
    pool = (titled.length ? titled : nearYear).slice(0, 4);
  const films = await Promise.all(
    [...new Set(pool.map((credit) => credit.id))].map((id) =>
      getFilm(`tmdb:${id}`, budget),
    ),
  );
  const verified = films.filter(
    (film) =>
      movieTitleMatches(film, title) &&
      Math.abs(film.year - year) <= RESOLUTION_YEAR_TOLERANCE &&
      directedBy(film, director),
  );
  return verified.length === 1 ? verified[0] : null;
}
export async function resolveCandidate(
  title: string,
  year: number,
  director: string,
  budget: Budget,
): Promise<Film | null> {
  const local = (await import("../catalogue")).collection.find(
    (f) =>
      titleMatches(f.title, title) &&
      Math.abs(f.year - year) <= 1 &&
      directorMatches(f.director, director),
  );
  if (local) return local;
  if (!norm(director)) return null;
  // Filter by year before limiting results: common titles otherwise push the right film past the first eight hits.
  const data = await tmdb<TmdbSearch<TmdbMovie>>(
    `/search/movie?query=${encodeURIComponent(title)}&year=${year}&include_adult=false&language=en-US&page=1`,
    budget,
  );
  let hits = (data.results ?? [])
    .filter((row) => row.release_date && row.title)
    .slice(0, 12)
    .map(basic);
  let sameYear = hits.filter(
      (f) => Math.abs(f.year - year) <= RESOLUTION_YEAR_TOLERANCE,
    ),
    exact = sameYear.filter((f) =>
      movieTitleMatches(
        { title: f.title, originalTitle: f.originalTitle },
        title,
      ),
    );
  // TMDB's `year` parameter can hide a film when festival and theatrical years differ.
  // Retry only when the filtered search has no exact title, then merge by canonical ID.
  if (!exact.length) {
    const broader = await searchTMDB(title, budget);
    hits = [
      ...new Map([...hits, ...broader].map((film) => [film.id, film])).values(),
    ];
    sameYear = hits.filter(
      (f) => Math.abs(f.year - year) <= RESOLUTION_YEAR_TOLERANCE,
    );
    exact = sameYear.filter((f) =>
      movieTitleMatches(
        { title: f.title, originalTitle: f.originalTitle },
        title,
      ),
    );
  }
  const choices = exact.length ? exact : sameYear;
  const verified: Film[] = [];
  if (choices.length <= 4)
    for (const hit of choices) {
      const full = await getFilm(hit.id, budget);
      if (
        movieTitleMatches(full, title) &&
        Math.abs(full.year - year) <= RESOLUTION_YEAR_TOLERANCE &&
        directedBy(full, director)
      )
        verified.push(full);
    }
  // A DB search can match a documented alternative title. The year and director still have to identify a unique film.
  if (verified.length === 1) return verified[0];
  // Niche and experimental films are often absent from title search but present in a
  // director's TMDB credits. This path is conservative: the person, directing credit,
  // title/original title, release year, and canonical movie details must all agree.
  return resolveFromDirectorCredits(title, year, director, budget);
}
