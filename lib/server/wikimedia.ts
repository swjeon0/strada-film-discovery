import { titleMatches } from "./film-identity";
import { AppError } from "./config";
import type { Budget } from "./tmdb";
import type { Film, Language } from "../domain";
import knownMetadata from "../film-metadata.json";

const USER_AGENT =
  "STRADA/2.0 (https://strada-film-discovery.vercel.app; film discovery)";
const FILM_TYPES = new Set([
  "Q11424",
  "Q24862",
  "Q24869",
  "Q202866",
  "Q506240",
  "Q20667187",
  "Q29168811",
  "Q226730",
  "Q17517379",
  "Q93204",
]);

type WikiValue = { id?: string; time?: string; text?: string };
type WikiClaim = {
  rank?: string;
  mainsnak?: { datavalue?: { value?: WikiValue } };
};
type WikiEntity = {
  id: string;
  claims?: Record<string, WikiClaim[]>;
  labels?: Record<string, { value?: string }>;
  aliases?: Record<string, { value: string }[]>;
  sitelinks?: Record<string, { title?: string }>;
};
type WikiPage = {
  title: string;
  missing?: boolean;
  pageprops?: { wikibase_item?: string };
  extract?: string;
  pageimage?: string;
  thumbnail?: { source?: string };
};
type WikiResponse = {
  error?: unknown;
  entities?: Record<string, WikiEntity>;
  search?: { id?: string }[];
  query?: { pages?: WikiPage[] };
};

const cache = new Map<string, { at: number; value: WikiResponse }>();

export async function wikiApi(
  host: "www.wikidata.org" | "en.wikipedia.org" | "ko.wikipedia.org",
  params: Record<string, string>,
  budget?: Budget,
): Promise<WikiResponse> {
  const url = `https://${host}/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params })}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
  if (budget) {
    if (budget.remaining <= 0)
      throw new AppError(
        "BUDGET",
        "The movie service reached its request limit. Please try again.",
        429,
      );
    budget.remaining--;
  }
  const signal = budget?.signal
    ? AbortSignal.any([budget.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      response.status === 429 ? "RATE_LIMIT" : "METADATA_ERROR",
      "Movie search is temporarily unavailable.",
      response.status === 429 ? 429 : 502,
    );
  }
  const data = (await response.json()) as WikiResponse;
  if (data.error)
    throw new AppError(
      "METADATA_ERROR",
      "The movie database could not complete this search.",
      502,
    );
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(url, { at: Date.now(), value: data });
  return data;
}

const values = (entity: WikiEntity, property: string) =>
  (entity.claims?.[property] ?? [])
    .filter((statement) => statement.rank !== "deprecated")
    .flatMap((statement) =>
      statement.mainsnak?.datavalue?.value
        ? [statement.mainsnak.datavalue.value]
        : [],
    );
const qids = (entity: WikiEntity, property: string) =>
  values(entity, property).flatMap((value) => (value.id ? [value.id] : []));
const norm = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\p{P}\p{M}\s]/gu, "");
export const knownByQid = (id: string) =>
  knownMetadata.find((film) => film.qid === id);
export function isMovieEntity(entity: WikiEntity) {
  return (
    qids(entity, "P31").some((id) => FILM_TYPES.has(id)) &&
    values(entity, "P577").length > 0
  );
}

async function entities(
  ids: string[],
  budget?: Budget,
): Promise<Record<string, WikiEntity>> {
  if (!ids.length) return {};
  return (
    (
      await wikiApi(
        "www.wikidata.org",
        {
          action: "wbgetentities",
          ids: [...new Set(ids)].join("|"),
          props: "labels|aliases|descriptions|claims|sitelinks",
          languages: "en|mul|ko",
          sitefilter: "enwiki|kowiki",
        },
        budget,
      )
    ).entities ?? {}
  );
}

function mapEntity(
  entity: WikiEntity,
  related: Record<string, WikiEntity>,
): Film | null {
  if (!isMovieEntity(entity)) return null;
  const known = knownByQid(entity.id),
    dates = values(entity, "P577").flatMap((value) => {
      const year = Number(value.time?.slice(1, 5));
      return year > 1850 && year < 2200 ? [year] : [];
    });
  if (!dates.length) return null;
  const label = (id: string) =>
    related[id]?.labels?.en?.value ??
    related[id]?.labels?.mul?.value ??
    known?.director ??
    "";
  const director = qids(entity, "P57").map(label).filter(Boolean).join(", ");
  const countries = qids(entity, "P495")
    .map((id) => related[id]?.labels?.en?.value)
    .filter(Boolean)
    .join(" / ");
  const ko = entity.labels?.ko?.value;
  return {
    id: `wd:${entity.id}`,
    wikidataId: entity.id,
    title:
      entity.labels?.en?.value ??
      entity.labels?.mul?.value ??
      values(entity, "P1476")[0]?.text ??
      ko ??
      entity.id,
    titleKo: ko,
    titleKoSource: ko
      ? `https://www.wikidata.org/wiki/${entity.id}`
      : undefined,
    aliases: [
      ...(entity.aliases?.en ?? []),
      ...(entity.aliases?.mul ?? []),
    ].map((alias) => alias.value),
    year: Math.min(...dates),
    director,
    poster: known?.poster ?? "",
    country: countries || undefined,
    genres: qids(entity, "P136"),
    originalTitle: values(entity, "P1476")[0]?.text,
    wikiEn: entity.sitelinks?.enwiki?.title,
    wikiKo: entity.sitelinks?.kowiki?.title,
    overviewEn: known?.overviewEn,
    overviewKo: known?.overviewKo,
    overviewEnSource: known?.overviewEnSource,
    overviewKoSource: known?.overviewKoSource,
  };
}

async function mapEntities(
  rows: Record<string, WikiEntity>,
  budget?: Budget,
  posters = false,
) {
  const films = Object.values(rows).filter(isMovieEntity),
    relatedIds = films.flatMap((entity) => [
      ...qids(entity, "P57"),
      ...qids(entity, "P495"),
    ]);
  const [relatedResult, illustrated] = await Promise.all([
    relatedIds.length
      ? wikiApi(
          "www.wikidata.org",
          {
            action: "wbgetentities",
            ids: [...new Set(relatedIds)].join("|"),
            props: "labels",
            languages: "en|mul|ko",
          },
          budget,
        )
      : Promise.resolve({ entities: {} } as WikiResponse),
    posters
      ? enrichPosterBatch(
          films
            .map((entity) => mapEntity(entity, {}))
            .filter((film): film is Film => !!film),
          budget,
        ).catch(() => [])
      : Promise.resolve([] as Film[]),
  ]);
  return films
    .map((entity) => {
      const film = mapEntity(entity, relatedResult.entities ?? {});
      return film
        ? {
            ...film,
            poster:
              illustrated.find((row) => row.id === film.id)?.poster ||
              film.poster,
          }
        : null;
    })
    .filter((film): film is Film => !!film);
}

export async function filmsFromQids(ids: string[], budget?: Budget) {
  return mapEntities(await entities(ids, budget), budget);
}
export async function searchWikimedia(
  query: string,
  language: Language,
  budget?: Budget,
): Promise<Film[]> {
  const data = await wikiApi(
    "www.wikidata.org",
    {
      action: "wbsearchentities",
      search: query,
      language,
      uselang: language,
      limit: "16",
      type: "item",
    },
    budget,
  );
  const ids = (data.search ?? []).flatMap((item) =>
    item.id && /^Q\d+$/.test(item.id) ? [item.id] : [],
  );
  if (!ids.length) return [];
  const mapped = await mapEntities(await entities(ids, budget), budget, true),
    index = new Map(ids.map((id, position) => [id, position]));
  return mapped
    .sort(
      (left, right) =>
        (index.get(left.wikidataId!) ?? 999) -
        (index.get(right.wikidataId!) ?? 999),
    )
    .slice(0, 8);
}
export async function getWikimediaFilm(
  id: string,
  budget?: Budget,
): Promise<Film> {
  const qid = id.replace(/^wd:/, "");
  if (!/^Q[1-9]\d*$/.test(qid))
    throw new AppError(
      "INVALID_FILM",
      "This film could not be identified.",
      400,
    );
  const known = knownByQid(qid);
  if (known)
    return {
      ...known,
      id: `wd:${qid}`,
      wikidataId: qid,
      titleKo: known.titleKo || undefined,
    } as Film;
  const films = await mapEntities(await entities([qid], budget), budget);
  if (!films[0])
    throw new AppError(
      "INVALID_FILM",
      "This database entry is not a film.",
      400,
    );
  return films[0];
}

function cleanText(text: string) {
  return text
    .replace(/\[[0-9]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function plotExcerpt(extract: string) {
  const match = extract.match(
    /(?:^|\n)==\s*(?:Plot(?: summary)?|Synopsis|줄거리|내용)\s*==\s*\n([\s\S]*?)(?=\n==|$)/i,
  );
  if (!match) return "";
  const paragraphs = match[1]
      .split(/\n\s*\n/)
      .map(cleanText)
      .filter((paragraph) => paragraph && !paragraph.startsWith("=")),
    first = paragraphs[0] ?? "";
  if (first.length <= 1000) return first;
  const sentence = first.slice(0, 1000).match(/^[\s\S]*[.!?。다][.!?。]?\s/);
  return (sentence?.[0] ?? first.slice(0, 1000)).trim() + "…";
}
export async function enrichWikipedia(
  film: Film,
  language: Language,
  budget?: Budget,
): Promise<Film> {
  const hasSynopsis = language === "ko" ? film.synopsisKo : film.synopsisEn;
  if (hasSynopsis) return film;
  let lang: Language = language,
    title = language === "ko" ? film.wikiKo : film.wikiEn;
  if (!title) {
    lang = "en";
    title = film.wikiEn;
  }
  if (!title) return film;
  const data = await wikiApi(
    `${lang}.wikipedia.org`,
    {
      action: "query",
      titles: decodeURIComponent(title),
      redirects: "1",
      prop: "pageprops|pageimages|extracts",
      ppprop: "wikibase_item",
      piprop: "thumbnail|name",
      pithumbsize: "400",
      pilicense: "any",
      explaintext: "1",
      exsectionformat: "wiki",
    },
    budget,
  );
  const page = data.query?.pages?.[0];
  if (
    !page ||
    page.missing ||
    page.pageprops?.wikibase_item !== film.wikidataId
  )
    return film;
  const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`,
    extract = page.extract ?? "",
    synopsis = plotExcerpt(extract),
    intro = cleanText(extract.split(/\n==/)[0]).slice(0, 1000);
  const poster =
    film.poster ||
    (!/logo|portrait|director|signature/.test(
      (page.pageimage ?? "").toLowerCase(),
    )
      ? page.thumbnail?.source
      : "") ||
    "";
  return {
    ...film,
    poster,
    ...(lang === "ko"
      ? {
          overviewKo: intro,
          overviewKoSource: url,
          synopsisKo: synopsis || undefined,
          synopsisKoSource: synopsis ? url : undefined,
        }
      : {
          overviewEn: intro,
          overviewEnSource: url,
          synopsisEn: synopsis || undefined,
          synopsisEnSource: synopsis ? url : undefined,
        }),
  };
}
export async function resolveWikimediaCandidate(
  title: string,
  year: number,
  director: string,
  budget: Budget,
): Promise<Film | null> {
  if (!norm(director)) return null;
  const known = knownMetadata.find(
    (film) =>
      titleMatches(film.title, title) &&
      Math.abs(film.year - year) <= 1 &&
      norm(film.director) === norm(director),
  );
  if (known) return getWikimediaFilm(known.id, budget);
  const hits = await searchWikimedia(title, "en", budget),
    exact = hits.filter(
      (film) =>
        [
          film.title,
          ...(film.aliases ?? []),
          film.wikiEn?.replace(/\s*\([^)]*film[^)]*\)$/i, "") ?? "",
        ].some((alias) => norm(alias) === norm(title)) &&
        Math.abs(film.year - year) <= 1 &&
        (norm(film.director) === norm(director) ||
          film.director
            .split(",")
            .some((name) => norm(name) === norm(director))),
    );
  return exact.length === 1 ? exact[0] : null;
}
export async function getWikimediaFilms(
  ids: string[],
  budget?: Budget,
): Promise<Film[]> {
  const unique = [...new Set(ids)],
    missing = unique.filter((id) => !knownByQid(id.replace(/^wd:/, ""))),
    fetched = missing.length
      ? await mapEntities(
          await entities(
            missing.map((id) => id.replace(/^wd:/, "")),
            budget,
          ),
          budget,
        )
      : [],
    result: Film[] = [];
  for (const id of ids) {
    const known = knownByQid(id.replace(/^wd:/, "")),
      film = known
        ? await getWikimediaFilm(id, budget)
        : fetched.find((item) => item.id === id);
    if (!film)
      throw new AppError(
        "INVALID_FILM",
        "This film could not be identified.",
        400,
      );
    result.push(film);
  }
  return result;
}
export async function enrichPosterBatch(
  films: Film[],
  budget?: Budget,
): Promise<Film[]> {
  const missing = films.filter(
    (film) => !film.poster && film.wikiEn && film.wikidataId,
  );
  if (!missing.length) return films;
  const data = await wikiApi(
      "en.wikipedia.org",
      {
        action: "query",
        titles: missing
          .map((film) => decodeURIComponent(film.wikiEn!))
          .join("|"),
        redirects: "1",
        prop: "pageprops|pageimages",
        ppprop: "wikibase_item",
        piprop: "thumbnail|name",
        pithumbsize: "500",
        pilicense: "any",
      },
      budget,
    ),
    pages = data.query?.pages ?? [];
  return films.map((film) => {
    const page = pages.find(
      (item) => item.pageprops?.wikibase_item === film.wikidataId,
    );
    if (!page) return film;
    return {
      ...film,
      poster:
        film.poster ||
        (!/logo|portrait|signature/i.test(page.pageimage ?? "")
          ? page.thumbnail?.source
          : "") ||
        "",
      overviewEn: film.overviewEn || page.extract,
      overviewEnSource:
        film.overviewEnSource ||
        `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`,
    };
  });
}
