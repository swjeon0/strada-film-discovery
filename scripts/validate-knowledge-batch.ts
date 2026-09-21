import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import { z } from "zod";
import { normalizeQuote } from "./audit-knowledge-sources";
import type { CollectionManifest, CollectionItem } from "./collect-knowledge";

const Candidate = z.object({
  admit: z.boolean(),
  accessAssessment: z.enum(["full_text", "abstract_only", "metadata_only", "uncertain"]),
  document: z.object({
    title: z.string().nullable(),
    author: z.string().nullable(),
    publishedAt: z.string().nullable(),
    language: z.string(),
    sourceType: z.enum(["criticism", "academic", "programme", "festival"]),
  }),
  films: z.array(
    z.object({
      title: z.string(),
      year: z.number().int().nullable(),
      director: z.string().nullable(),
      aliases: z.array(z.string()),
      evidencePhrase: z.string(),
    }),
  ).max(6),
  observations: z.array(
    z.object({
      kind: z.enum([
        "film_reading",
        "comparison",
        "contrast",
        "influence",
        "co_programming",
        "historical_context",
        "incidental_mention",
      ]),
      filmIndexes: z.array(z.number().int()).min(1),
      summary: z.string(),
      summaryKo: z.string(),
      boundary: z.string(),
      subjects: z.array(z.string()).min(1),
      anchorQuote: z.string(),
      confidence: z.number(),
    }),
  ).max(3),
  rejectionReasons: z.array(z.string()),
});
type CandidateValue = z.infer<typeof Candidate>;
type TmdbFilm = {
  id: number;
  title: string;
  originalTitle: string;
  year: number;
  director: string;
};
type RecordFilm = {
  key: string;
  title: string;
  year: number;
  director: string;
  aliases: string[];
  externalIds: { provider: string; id: string }[];
};

type ParsedItem = {
  target: CollectionItem;
  sourceText: string;
  candidate: CandidateValue;
  observations: (CandidateValue["observations"][number] & { eligible: boolean })[];
};

export function extractResponseText(body: unknown) {
  const value = body as {
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  };
  return value.output
    ?.flatMap((item) => item.content ?? [])
    .find((part) => part.type === "output_text")?.text;
}

export function auditCandidate(candidate: CandidateValue, sourceText: string) {
  const academicAbstract =
      candidate.document.sourceType === "academic" && candidate.accessAssessment !== "full_text",
    observations = candidate.observations.map((observation) => {
      const quote = normalizeQuote(observation.anchorQuote),
        quoteMatched = Boolean(quote) && normalizeQuote(sourceText).includes(quote),
        quoteWords = observation.anchorQuote.trim().split(/\s+/).filter(Boolean).length,
        filmIndexesValid =
          observation.filmIndexes.length > 0 &&
          observation.filmIndexes.every((index) => index >= 0 && index < candidate.films.length),
        relational = ["comparison", "contrast", "influence", "co_programming"].includes(
          observation.kind,
        ),
        eligible =
          candidate.admit &&
          !academicAbstract &&
          observation.kind !== "incidental_mention" &&
          observation.confidence >= 0.5 &&
          quoteMatched &&
          quoteWords <= 20 &&
          filmIndexesValid &&
          (!relational || new Set(observation.filmIndexes).size >= 2);
      return { ...observation, quoteMatched, quoteWords, filmIndexesValid, eligible };
    });
  return {
    ...candidate,
    admit: candidate.admit && !academicAbstract,
    automaticBlocks: [
      ...(academicAbstract ? ["academic_without_full_text"] : []),
      ...(observations.some((row) => !row.quoteMatched) ? ["quote_not_found"] : []),
      ...(observations.some((row) => row.quoteWords > 20) ? ["quote_over_20_words"] : []),
      ...(observations.some((row) => !row.filmIndexesValid) ? ["invalid_film_reference"] : []),
    ],
    observations,
  };
}

const identity = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const personTokens = (value: string) =>
  new Set(
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
const directorsAgree = (proposed: string | null, actual: string) => {
  if (!proposed) return true;
  const left = personTokens(proposed), right = personTokens(actual);
  return [...left].some((token) => token.length > 2 && right.has(token));
};
const trimWords = (value: string, limit: number) =>
  value.trim().split(/\s+/).filter(Boolean).slice(0, limit).join(" ");
const safeDate = (value: string | null) =>
  value &&
  (/^\d{4}$/.test(value) || /^\d{4}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
    ? value
    : null;

async function tmdb(path: string, token: string) {
  const response = await fetch(`https://api.themoviedb.org/3${path}`, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`TMDB_${response.status}`);
  return response.json() as Promise<unknown>;
}

async function resolveFilm(
  film: CandidateValue["films"][number],
  token: string,
): Promise<TmdbFilm | null> {
  const query = new URLSearchParams({ query: film.title, include_adult: "false", language: "en-US" });
  if (film.year) query.set("year", String(film.year));
  const search = (await tmdb(`/search/movie?${query}`, token)) as {
    results?: { id: number; title: string; original_title: string; release_date?: string }[];
  };
  const ranked = (search.results ?? [])
    .map((row) => ({
      ...row,
      year: Number.parseInt(row.release_date?.slice(0, 4) ?? "0", 10),
      titleMatch:
        identity(row.title) === identity(film.title) ||
        identity(row.original_title) === identity(film.title) ||
        film.aliases.some(
          (alias) => identity(row.title) === identity(alias) || identity(row.original_title) === identity(alias),
        ),
    }))
    .filter((row) => row.titleMatch && (!film.year || Math.abs(row.year - film.year) <= 1))
    .slice(0, 4);
  for (const row of ranked) {
    const details = (await tmdb(`/movie/${row.id}/credits?language=en-US`, token)) as {
      crew?: { job?: string; name?: string }[];
    };
    const director = details.crew?.find((person) => person.job === "Director")?.name;
    if (director && row.year && directorsAgree(film.director, director))
      return { id: row.id, title: row.title, originalTitle: row.original_title, year: row.year, director };
  }
  return null;
}

async function concurrentMap<T, U>(rows: T[], width: number, fn: (row: T) => Promise<U>) {
  const output = new Array<U>(rows.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (cursor < rows.length) {
        const index = cursor++;
        output[index] = await fn(rows[index]);
      }
    }),
  );
  return output;
}

async function main() {
  nextEnv.loadEnvConfig(process.cwd());
  const args = process.argv.slice(2),
    get = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    },
    manifestPath = resolve(
      get("--manifest") ?? "research/knowledge/collection/manifests/scale-500-2026-09-20.json",
    ),
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CollectionManifest,
    resultPath = resolve(
      get("--results") ?? `work/knowledge/collection/${manifest.jobId}/batch-output.jsonl`,
    ),
    output = resolve(
      get("--out") ?? `work/knowledge/collection/${manifest.jobId}/validated-records.json`,
    ),
    reportPath = resolve(
      get("--report") ?? `work/knowledge/collection/${manifest.jobId}/validation-report.json`,
    ),
    limit = Math.max(1, Number.parseInt(get("--limit") ?? "500", 10)),
    token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) throw new Error("TMDB_READ_ACCESS_TOKEN is required for automatic film identity validation.");
  const items = new Map(manifest.items.map((item) => [item.targetId, item])),
    parsed: ParsedItem[] = [],
    failures: { targetId: string; reason: string }[] = [];
  for (const line of (await readFile(resultPath, "utf8")).split(/\n+/).filter(Boolean)) {
    const result = JSON.parse(line) as {
      custom_id: string;
      response?: { status_code?: number; body?: unknown };
      error?: unknown;
    };
    const marker = `${manifest.jobId}__`,
      targetId = result.custom_id.startsWith(marker) ? result.custom_id.slice(marker.length) : "",
      target = items.get(targetId);
    if (!target?.rawTextPath) {
      failures.push({ targetId: targetId || result.custom_id, reason: "unmatched_result" });
      continue;
    }
    const responseText = extractResponseText(result.response?.body);
    if (result.response?.status_code !== 200 || !responseText) {
      failures.push({ targetId, reason: "api_error" });
      continue;
    }
    try {
      const candidate = Candidate.parse(JSON.parse(responseText)),
        sourceText = await readFile(resolve(target.rawTextPath), "utf8"),
        audited = auditCandidate(candidate, sourceText),
        observations = audited.observations.filter((row) => row.eligible);
      if (!observations.length) {
        failures.push({ targetId, reason: audited.automaticBlocks[0] ?? "no_eligible_observation" });
        continue;
      }
      parsed.push({ target, sourceText, candidate, observations });
    } catch (error) {
      failures.push({
        targetId,
        reason: error instanceof Error ? `invalid_model_output:${error.message.slice(0, 120)}` : "invalid_model_output",
      });
    }
  }

  const unique = new Map<
    string,
    { film: CandidateValue["films"][number]; resolved: Promise<TmdbFilm | null> }
  >();
  for (const item of parsed)
    for (const observation of item.observations)
      for (const index of observation.filmIndexes) {
        const film = item.candidate.films[index],
          key = `${identity(film.title)}:${film.year ?? ""}:${identity(film.director ?? "")}`;
        if (!unique.has(key)) unique.set(key, { film, resolved: Promise.resolve(null) });
      }
  const filmRows = [...unique.entries()];
  const resolvedRows = await concurrentMap(filmRows, 8, async ([key, value]) => {
    try {
      return [key, await resolveFilm(value.film, token)] as const;
    } catch {
      return [key, null] as const;
    }
  });
  const resolutions = new Map(resolvedRows), records: unknown[] = [];
  for (const item of parsed) {
    const observation = [...item.observations]
      .sort(
        (a, b) =>
          a.filmIndexes.length - b.filmIndexes.length ||
          b.confidence - a.confidence ||
          a.kind.localeCompare(b.kind),
      )
      .find((candidate) =>
        candidate.filmIndexes.every((index) => {
          const film = item.candidate.films[index],
            key = `${identity(film.title)}:${film.year ?? ""}:${identity(film.director ?? "")}`;
          return Boolean(resolutions.get(key));
        }),
      );
    if (!observation) {
      failures.push({ targetId: item.target.targetId, reason: "film_identity_not_resolved" });
      continue;
    }
    const resolvedFilms = new Map<number, TmdbFilm>();
    for (const index of observation.filmIndexes) {
      const film = item.candidate.films[index],
        key = `${identity(film.title)}:${film.year ?? ""}:${identity(film.director ?? "")}`,
        resolved = resolutions.get(key);
      if (resolved) resolvedFilms.set(index, resolved);
    }
    const films: RecordFilm[] = [...resolvedFilms].map(([index, film]) => {
      const proposed = item.candidate.films[index];
      return {
        key: `tmdb-${film.id}`,
        title: film.title,
        year: film.year,
        director: film.director,
        aliases: [...new Set([film.originalTitle, ...proposed.aliases])].filter(
          (alias) => alias && identity(alias) !== identity(film.title),
        ),
        externalIds: [{ provider: "tmdb", id: String(film.id) }],
      };
    });
    const indexToKey = new Map(
      [...resolvedFilms].map(([index, film]) => [index, `tmdb-${film.id}`]),
    );
    records.push({
      id: item.target.targetId,
      url: item.target.canonicalUrl,
      title: item.candidate.document.title?.trim() || item.target.titleHint || item.target.targetId,
      author: item.candidate.document.author,
      publisher: item.target.publisher,
      type: item.target.proposedType,
      language: item.candidate.document.language || item.target.language,
      publishedAt: safeDate(item.candidate.document.publishedAt),
      checkedAt: item.target.checkedAt,
      access: "full_page",
      rights: item.target.rights,
      verification: {
        method: "http_fetch",
        locator: "Exact quotation matched in the fetched publisher text.",
        note: "Automatically extracted, quote-matched, schema-validated, and film-resolved against TMDB.",
      },
      films,
      passages: [
        {
          id: "p1",
          text: observation.anchorQuote,
          locator: "Exact quotation matched in the fetched publisher text.",
        },
      ],
      observations: [
        {
          id: "o1",
          summary: trimWords(observation.summary, 55),
          summaryKo: trimWords(observation.summaryKo, 55),
          boundary: trimWords(observation.boundary, 35),
          filmKeys: [...new Set(observation.filmIndexes.map((index) => indexToKey.get(index)!))],
          subjects: [...new Set(observation.subjects)].slice(0, 20),
          kind: observation.kind,
          passageIds: ["p1"],
        },
      ],
    });
    if (records.length === limit) break;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(records, null, 2) + "\n");
  const report = {
    version: 1,
    jobId: manifest.jobId,
    generatedAt: new Date().toISOString(),
    requested: limit,
    publishedCandidates: records.length,
    parsedCandidates: parsed.length,
    modelResults: parsed.length + failures.filter((row) => row.reason !== "film_identity_not_resolved").length,
    filmIdentitiesChecked: unique.size,
    failures,
    status: records.length === limit ? "validated" : "insufficient_valid_records",
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ records: records.length, requested: limit, output, report: reportPath }, null, 2));
  if (records.length !== limit)
    throw new Error(`Automatic validation produced ${records.length}/${limit} records. Add sources or retry failed model outputs.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Validation failed.");
    process.exitCode = 1;
  });
