import test from "node:test";
import assert from "node:assert/strict";
import type { Film } from "../lib/domain";
import {
  CuratorWireSchema,
  decodeCuratorWire,
  validateCuratorOutput,
  type CuratorOutput,
  type CuratorRequest,
} from "../lib/server/curator/contract";
import { curateOnce } from "../lib/server/curator/model";
import { runCurator } from "../lib/server/curator/engine";
import { CorpusKnowledgeRepository } from "../lib/server/knowledge/corpus";
import { directorMatches } from "../lib/server/metadata";
import {
  CuratorIdentityError,
  resolveCuratorOutput,
} from "../lib/server/curator/resolve";
import {
  resolveCandidate as resolveTmdbCandidate,
  tmdb,
  tmdbRetryDelayMs,
} from "../lib/server/tmdb";
import {
  parseCuratorBenchmarkOptions,
  runCuratorBenchmark,
} from "../scripts/benchmark-curator";

const seeds: Film[] = [
  {
    id: "tmdb:126238",
    title: "Ten Skies",
    year: 2004,
    director: "James Benning",
    poster: "",
  },
  {
    id: "tmdb:43838",
    title: "Young Mr. Lincoln",
    year: 1939,
    director: "John Ford",
    poster: "",
  },
];
const output = (
  attribution:
    | "source_supported_interpretation"
    | "model_proposal" = "model_proposal",
): CuratorOutput => ({
  lens: "Material traces turn duration into a way of seeing historical change.",
  description:
    "The path treats landscape and objects as active records instead of decorative settings.",
  recommendations: Array.from({ length: 12 }, (_, index) => ({
    title: `Film ${index}`,
    year: 1950 + index,
    director: `Director ${index}`,
    anchorIds: seeds.map((film) => film.id),
    connection: `Shared formal and historical axis ${index}.`,
    evidenceIds:
      attribution === "model_proposal" ? [] : ["P-TEN-SKIES-IFFR-01"],
    attribution,
  })),
});

test("corpus retrieval is set-based and never pads with unrelated passages", async () => {
  const repository = new CorpusKnowledgeRepository(),
    first = await repository.buildContext(seeds, "ko"),
    reversed = await repository.buildContext([...seeds].reverse(), "ko");
  assert.deepEqual(
    first.passages.map((item) => item.id),
    reversed.passages.map((item) => item.id),
  );
  assert.deepEqual(first.selectedFilmIds, reversed.selectedFilmIds);
  assert.ok(first.passages.length > 0 && first.passages.length <= 24);
  assert.ok(
    first.passages.filter((item) => item.filmIds.includes(seeds[0].id))
      .length >= 1,
  );
  assert.ok(
    first.passages.filter((item) => item.filmIds.includes(seeds[1].id))
      .length >= 1,
  );
  assert.ok(
    first.passages.every((item) =>
      (item.retrievedFor ?? []).some((id) =>
        seeds.some((seed) => seed.id === id),
      ),
    ),
  );
  const unknown = await repository.buildContext(
    [
      {
        id: "tmdb:999999",
        title: "A Film Missing From This Fixture",
        year: 2026,
        director: "Unknown Director",
        poster: "",
      },
    ],
    "en",
  );
  assert.deepEqual(unknown.passages, []);
});

test("compact wire output expands evidence indexes and preserves actual anchors", async () => {
  const repository = new CorpusKnowledgeRepository(),
    context = await repository.buildContext(seeds, "ko");
  const request: CuratorRequest = {
    selected: seeds,
    excludedIds: seeds.map((film) => film.id),
    language: "ko",
    context,
  };
  const item = (index: number) => ({
    t: `Wire Film ${index}`,
    y: 1960 + index,
    d: `Wire Director ${index}`,
    a: [index % 2],
    b: `두 입력의 형식과 역사성을 함께 읽는 연결 ${index}`,
    e: [],
    k: "m" as const,
  });
  const wire = {
    v: "형식적 제약이 역사의 표면을 다시 보게 하는 경로",
    r: Array.from({ length: 12 }, (_, index) => item(index)),
  };
  const decoded = decodeCuratorWire(wire, request);
  assert.deepEqual(decoded.recommendations[0].anchorIds, [seeds[0].id]);
  assert.equal(decoded.description, decoded.lens);
  assert.equal(decoded.recommendations.length, 12);
  assert.equal(
    CuratorWireSchema.safeParse({ ...wire, r: wire.r.slice(0, 11) }).success,
    false,
  );
  assert.equal(
    CuratorWireSchema.safeParse({
      ...wire,
      x: [{ t: "Legacy reserve", y: 2000, d: "Director" }],
    }).success,
    false,
  );
  const contradictory = {
    v: "형식과 역사를 잇는 관점",
    r: Array.from({ length: 12 }, (_, index) => ({ ...item(index), e: [0] })),
  };
  assert.deepEqual(
    decodeCuratorWire(contradictory, request).recommendations[0].evidenceIds,
    [],
  );
  const wrongLanguage = decodeCuratorWire(
    {
      v: "An English lens despite a Korean request",
      r: Array.from({ length: 12 }, (_, index) => item(index)),
    },
    request,
  );
  assert.match(wrongLanguage.lens, /[가-힣]/u);
});

test("an empty corpus downgrades stray evidence indexes instead of failing curation", async () => {
  const repository = new CorpusKnowledgeRepository(),
    full = await repository.buildContext(seeds, "ko"),
    request: CuratorRequest = {
      selected: seeds,
      excludedIds: seeds.map((film) => film.id),
      language: "ko",
      context: { ...full, passages: [] },
    };
  const primary = (index: number) => ({
    t: `Empty Context Film ${index}`,
    y: 1960 + index,
    d: `Director ${index}`,
    a: [index % 2],
    b: `문헌 없이 구성한 형식적 연결 ${index}`,
    e: [0],
    k: "s" as const,
  });
  const decoded = decodeCuratorWire(
    {
      v: "문헌이 없는 입력에서도 정직하게 제안하는 경로",
      r: Array.from({ length: 12 }, (_, index) => primary(index)),
    },
    request,
  );
  assert.equal(decoded.recommendations[0].attribution, "model_proposal");
  assert.deepEqual(decoded.recommendations[0].evidenceIds, []);
});

test("reasoning none is sent explicitly and compact tuples replace the verbose context payload", async () => {
  const repository = new CorpusKnowledgeRepository(),
    context = await repository.buildContext(seeds, "ko");
  const request: CuratorRequest = {
    selected: seeds,
    excludedIds: seeds.map((film) => film.id),
    language: "ko",
    context,
  };
  const item = (index: number) => ({
    t: `API Film ${index}`,
    y: 1960 + index,
    d: `API Director ${index}`,
    a: [index % 2],
    b: `두 입력을 함께 읽는 압축 연결 문장 ${index}`,
    e: [],
    k: "m",
  });
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let body: Record<string, unknown> | undefined;
  try {
    await curateOnce(
      request,
      {
        model: "gpt-5.4-mini",
        reasoning: "none",
        timeoutMs: 1000,
        maxOutputTokens: 1200,
      },
      new AbortController().signal,
      async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            status: "completed",
            model: "fixture",
            usage: { input_tokens: 10, output_tokens: 10 },
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      v: "두 영화의 물질과 역사를 잇는 압축된 관점",
                      r: Array.from({ length: 12 }, (_, index) => item(index)),
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  assert.deepEqual(body?.reasoning, { effort: "none" });
  const input = body?.input as { content: string }[];
  const user = JSON.parse(input[1].content) as Record<string, unknown>;
  assert.deepEqual(Object.keys(user).sort(), ["f", "g", "p", "s", "x"]);
  assert.ok(Array.isArray(user.p));
  assert.deepEqual(
    user.f,
    seeds.map((film) => [film.title, film.year, film.director]),
  );
  const passages = user.p as unknown[][];
  assert.ok(passages.length > 0);
  assert.ok(
    passages.every(
      (tuple) => tuple.length <= 8 && typeof tuple[4] === "string",
    ),
    "context is sent as bounded tuples rather than verbose objects",
  );
  assert.ok(
    passages.some(
      (tuple) =>
        tuple[2] === "reviewed descriptors" || typeof tuple[7] === "object",
    ),
    "the tuple marks reviewed descriptors or a bounded reviewed observation",
  );
});

test("director identity tolerates diacritics and culturally reversed name order without fuzzy matching", () => {
  assert.equal(directorMatches("Yasujirō Ozu", "Ozu Yasujiro"), true);
  assert.equal(directorMatches("John Ford", "Ford John"), true);
  assert.equal(directorMatches("John Ford", "John Huston"), false);
});

test("identity resolution verifies the exact twelve-film route without substitutes", async () => {
  const value = output(),
    calls: string[][] = [];
  const result = await resolveCuratorOutput(
    value,
    ["excluded"],
    new AbortController().signal,
    async (candidates) => {
      calls.push(candidates.map((candidate) => candidate.title));
      return candidates.map((candidate, index) => ({
        id: `film:${index}`,
        title: candidate.title,
        year: candidate.year,
        director: candidate.director,
        poster: "",
      }));
    },
  );
  assert.deepEqual(
    calls.map((call) => call.length),
    [12],
  );
  assert.deepEqual(
    result.recommendations.map((item) => item.film.title),
    Array.from({ length: 12 }, (_, index) => `Film ${index}`),
  );
});

test("identity failure retains original indexes after batched resolution", async () => {
  await assert.rejects(
    () =>
      resolveCuratorOutput(
        output(),
        [],
        new AbortController().signal,
        async (candidates) => candidates.map(() => null),
      ),
    (error) => {
      assert.ok(error instanceof CuratorIdentityError);
      assert.equal(error.details.unresolved.length, 12);
      assert.deepEqual(
        error.details.unresolved.map((item) => item.index),
        Array.from({ length: 12 }, (_, index) => index),
      );
      return true;
    },
  );
});

test("identity resolution fails instead of dropping an input film from the visible route", async () => {
  const value = output();
  value.recommendations = value.recommendations.map((proposal, index) => ({
    ...proposal,
    anchorIds: index === 0 ? [seeds[1].id] : [seeds[0].id],
  }));
  await assert.rejects(
    () =>
      resolveCuratorOutput(
        value,
        [],
        new AbortController().signal,
        async (candidates) =>
          candidates.map((candidate, index) =>
            index === 0
              ? null
              : {
                  id: `resolved:${candidate.title}`,
                  title: candidate.title,
                  year: candidate.year,
                  director: candidate.director,
                  poster: "",
                },
          ),
      ),
    (error) => {
      assert.ok(error instanceof CuratorIdentityError);
      assert.deepEqual(error.details.missingAnchorIds, [seeds[1].id]);
      return true;
    },
  );
});

test("TMDB retries one short transient failure and caps Retry-After", async (t) => {
  const previousToken = process.env.TMDB_READ_ACCESS_TOKEN,
    previousFetch = globalThis.fetch;
  process.env.TMDB_READ_ACCESS_TOKEN = "fixture-token";
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMDB_READ_ACCESS_TOKEN;
    else process.env.TMDB_READ_ACCESS_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
  });
  assert.equal(tmdbRetryDelayMs("10"), 300);
  assert.equal(tmdbRetryDelayMs("0"), 0);
  for (const [name, first] of [
    [
      "rate",
      () =>
        new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    ],
    [
      "server",
      () =>
        new Response(null, { status: 503, headers: { "retry-after": "0" } }),
    ],
    [
      "network",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ] as const) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1 ? first() : Response.json({ name });
    };
    assert.deepEqual(
      await tmdb(`/test-retry-${name}-${Date.now()}`, { remaining: 2 }),
      { name },
    );
    assert.equal(calls, 2);
  }
  let rejectedCalls = 0;
  globalThis.fetch = async () => {
    rejectedCalls++;
    return new Response(null, { status: 401 });
  };
  await assert.rejects(
    () => tmdb(`/test-no-retry-${Date.now()}`, { remaining: 2 }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "METADATA_ERROR",
  );
  assert.equal(rejectedCalls, 1);
});

test("TMDB candidate resolution never accepts an exact title and year from the wrong director", async (t) => {
  const previousToken = process.env.TMDB_READ_ACCESS_TOKEN,
    previousFetch = globalThis.fetch;
  process.env.TMDB_READ_ACCESS_TOKEN = "fixture-token";
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMDB_READ_ACCESS_TOKEN;
    else process.env.TMDB_READ_ACCESS_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
  });
  const title = `Identity Collision ${Date.now()}`,
    calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname === "/3/search/movie")
      return Response.json({
        results: [
          {
            id: 970001,
            title,
            original_title: title,
            release_date: "1972-05-01",
            poster_path: null,
          },
        ],
      });
    if (url.pathname === "/3/movie/970001")
      return Response.json({
        id: 970001,
        title,
        original_title: title,
        release_date: "1972-05-01",
        poster_path: null,
        overview: "",
        original_language: "en",
        genres: [],
        production_countries: [],
        credits: { crew: [{ job: "Director", name: "Another Director" }] },
        translations: { translations: [] },
      });
    if (url.pathname === "/3/search/person")
      return Response.json({
        results: [{ id: 970101, name: "Requested Director" }],
      });
    if (url.pathname === "/3/person/970101/movie_credits")
      return Response.json({ crew: [] });
    throw new Error(`Unexpected TMDB fixture URL: ${url.href}`);
  };
  const resolved = await resolveTmdbCandidate(
    title,
    1972,
    "Requested Director",
    { remaining: 20 },
  );
  assert.equal(resolved, null);
  assert.ok(
    calls.some((path) => path.startsWith("/3/search/person?")),
    "director filmography fallback was attempted after rejecting the wrong director",
  );
});

test("TMDB candidate resolution can recover niche films from an exact director filmography", async (t) => {
  const previousToken = process.env.TMDB_READ_ACCESS_TOKEN,
    previousFetch = globalThis.fetch;
  process.env.TMDB_READ_ACCESS_TOKEN = "fixture-token";
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMDB_READ_ACCESS_TOKEN;
    else process.env.TMDB_READ_ACCESS_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
  });
  const cases = [
    {
      query: "Empire",
      year: 1964,
      director: "Andy Warhol",
      personId: 971101,
      movieId: 971201,
      title: "Empire",
      originalTitle: "Empire",
      releaseYear: 1965,
    },
    {
      query: "D'Est",
      year: 1993,
      director: "Chantal Akerman",
      personId: 971102,
      movieId: 971202,
      title: "From the East",
      originalTitle: "D'Est",
      releaseYear: 1993,
    },
    {
      query: "Hôtel Monterey",
      year: 1973,
      director: "Chantal Akerman",
      personId: 971102,
      movieId: 971204,
      title: "Hotel Monterey",
      originalTitle: "Hôtel Monterey",
      releaseYear: 1976,
    },
    {
      query: "A Letter from Siberia",
      year: 1957,
      director: "Chris Marker",
      personId: 971103,
      movieId: 971203,
      title: "Letter from Siberia",
      originalTitle: "Lettre de Sibérie",
      releaseYear: 1958,
    },
    {
      query: "Nostalghia",
      year: 1983,
      director: "Andrei Tarkovsky",
      personId: 971104,
      movieId: 971205,
      title: "Nostalgia",
      originalTitle: "Ностальгия",
      releaseYear: 1983,
      aliases: ["Nostalghia"],
    },
  ];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input)),
      query = url.searchParams.get("query") ?? "";
    if (url.pathname === "/3/search/movie")
      return Response.json({ results: [] });
    if (url.pathname === "/3/search/person") {
      const row = cases.find((item) => item.director === query);
      return Response.json({
        results: row ? [{ id: row.personId, name: row.director }] : [],
      });
    }
    const person = url.pathname.match(
      /^\/3\/person\/(\d+)\/movie_credits$/,
    )?.[1];
    if (person) {
      const rows = cases.filter((item) => item.personId === Number(person));
      return Response.json({
        crew: rows.map((row) => ({
          id: row.movieId,
          title: row.title,
          original_title: row.originalTitle,
          release_date: `${row.releaseYear}-01-01`,
          job: "Director",
        })),
      });
    }
    const movie = url.pathname.match(/^\/3\/movie\/(\d+)$/)?.[1];
    if (movie) {
      const row = cases.find((item) => item.movieId === Number(movie));
      if (row)
        return Response.json({
          id: row.movieId,
          title: row.title,
          original_title: row.originalTitle,
          release_date: `${row.releaseYear}-01-01`,
          poster_path: null,
          overview: "",
          original_language: "en",
          genres: [],
          production_countries: [],
          credits: { crew: [{ job: "Director", name: row.director }] },
          translations: { translations: [] },
          alternative_titles: {
            titles: (row.aliases ?? []).map((title) => ({
              iso_3166_1: "US",
              title,
              type: "",
            })),
          },
        });
    }
    throw new Error(`Unexpected TMDB fixture URL: ${url.href}`);
  };
  for (const row of cases) {
    const resolved = await resolveTmdbCandidate(
      row.query,
      row.year,
      row.director,
      { remaining: 20 },
    );
    assert.equal(resolved?.id, `tmdb:${row.movieId}`);
    assert.equal(resolved?.originalTitle, row.originalTitle);
    assert.equal(resolved?.director, row.director);
  }
});

test("curator contract separates sourced interpretations from model proposals", async () => {
  const repository = new CorpusKnowledgeRepository(),
    context = await repository.buildContext(seeds, "en");
  const request: CuratorRequest = {
    selected: seeds,
    excludedIds: seeds.map((film) => film.id),
    language: "en",
    context,
  };
  assert.equal(
    validateCuratorOutput(output(), request).recommendations.length,
    12,
  );
  const evidenceId = context.passages[0]?.id;
  assert.ok(evidenceId);
  const invalid = output();
  invalid.recommendations[0] = {
    ...invalid.recommendations[0],
    evidenceIds: [evidenceId],
  };
  assert.throws(
    () => validateCuratorOutput(invalid, request),
    /CURATOR_MODEL_PROPOSAL_HAS_EVIDENCE/,
  );
  const precise = output();
  precise.recommendations = precise.recommendations.map((proposal, index) => ({
    ...proposal,
    anchorIds: [seeds[index % 2].id],
  }));
  assert.equal(
    validateCuratorOutput(precise, request).recommendations[0].anchorIds.length,
    1,
  );
  const incomplete = output();
  incomplete.recommendations = incomplete.recommendations.map((proposal) => ({
    ...proposal,
    anchorIds: [seeds[0].id],
  }));
  assert.throws(
    () => validateCuratorOutput(incomplete, request),
    /CURATOR_INCOMPLETE_SET_READING/,
  );
  const overstated = output("source_supported_interpretation");
  overstated.recommendations = overstated.recommendations.map((proposal) => ({
    ...proposal,
    evidenceIds: [evidenceId],
  }));
  overstated.recommendations[0] = {
    ...overstated.recommendations[0],
    attribution: "source_explicit",
  };
  assert.equal(
    validateCuratorOutput(overstated, request).recommendations[0].attribution,
    "source_supported_interpretation",
  );
});

test("engine makes one curator call and returns twelve resolved films", async () => {
  let calls = 0;
  const repository = new CorpusKnowledgeRepository();
  const result = await runCurator(
    {
      selected: seeds,
      excludedIds: [],
      language: "en",
      repository,
      options: {
        model: "test-model",
        reasoning: "low",
        timeoutMs: 1000,
        maxOutputTokens: 1000,
      },
      signal: new AbortController().signal,
    },
    {
      curate: async () => {
        calls++;
        return {
          output: output(),
          model: "test-model",
          elapsedMs: 7,
          usage: {
            model: "test-model",
            inputTokens: 10,
            outputTokens: 20,
            searchCalls: 0,
            estimatedUsd: 0,
          },
        };
      },
      resolve: async (value) => ({
        lens: value.lens,
        description: value.description,
        recommendations: value.recommendations.map((proposal, index) => ({
          film: {
            id: `tmdb:${1000 + index}`,
            title: proposal.title,
            year: proposal.year,
            director: proposal.director,
            poster: "",
          },
          anchorIds: proposal.anchorIds,
          connection: proposal.connection,
          evidenceIds: proposal.evidenceIds,
          attribution: proposal.attribution,
        })),
      }),
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.decision.recommendations.length, 12);
  assert.equal(result.timings.modelMs, 7);
});

test("engine repairs every failed identity slot in one bounded call and still exposes exactly twelve verified films", async () => {
  let curatorCalls = 0,
    repairCalls = 0,
    resolveCalls = 0;
  const repository = new CorpusKnowledgeRepository(),
    initial = output(),
    failed = [1, 3, 5, 7, 9];
  const result = await runCurator(
    {
      selected: seeds,
      excludedIds: [],
      language: "en",
      repository,
      options: {
        model: "main-model",
        reasoning: "none",
        timeoutMs: 1000,
        maxOutputTokens: 1000,
        repair: { model: "repair-model", timeoutMs: 500, maxOutputTokens: 300 },
      },
      signal: new AbortController().signal,
    },
    {
      curate: async () => {
        curatorCalls++;
        return {
          output: initial,
          model: "main-model",
          elapsedMs: 7,
          usage: {
            model: "main-model",
            inputTokens: 10,
            outputTokens: 20,
            searchCalls: 0,
            estimatedUsd: 0.01,
          },
        };
      },
      repair: async (_request, value, indexes) => {
        repairCalls++;
        assert.deepEqual(indexes, failed);
        const fixed = {
          ...value,
          recommendations: value.recommendations.map((proposal, index) =>
            failed.includes(index)
              ? {
                  ...proposal,
                  title: `Verified Replacement ${index}`,
                  year: 2000 + index,
                  director: `Verified Director ${index}`,
                }
              : proposal,
          ),
        };
        return {
          output: fixed,
          model: "repair-model",
          elapsedMs: 2,
          usage: {
            model: "repair-model",
            inputTokens: 3,
            outputTokens: 4,
            searchCalls: 0,
            estimatedUsd: 0.001,
          },
        };
      },
      resolve: async (value) => {
        resolveCalls++;
        if (resolveCalls === 1)
          throw new CuratorIdentityError({
            unresolved: failed.map((index) => ({
              index,
              title: value.recommendations[index].title,
              year: value.recommendations[index].year,
              director: value.recommendations[index].director,
            })),
            duplicateIds: [],
            excludedIds: [],
            duplicateIndexes: [],
            excludedIndexes: [],
            invalidIndexes: failed,
            missingAnchorIds: [],
          });
        return {
          lens: value.lens,
          description: value.description,
          recommendations: value.recommendations.map((proposal, index) => ({
            film: {
              id: `tmdb:${2000 + index}`,
              title: proposal.title,
              year: proposal.year,
              director: proposal.director,
              poster: "",
            },
            anchorIds: proposal.anchorIds,
            connection: proposal.connection,
            evidenceIds: proposal.evidenceIds,
            attribution: proposal.attribution,
          })),
        };
      },
    },
  );
  assert.equal(curatorCalls, 1);
  assert.equal(repairCalls, 1);
  assert.equal(resolveCalls, 2);
  assert.equal(result.decision.recommendations.length, 12);
  assert.equal(
    result.decision.recommendations[9].film.title,
    "Verified Replacement 9",
  );
  assert.deepEqual(result.repair, {
    attempted: true,
    model: "repair-model",
    indexes: failed,
  });
  assert.equal(result.usage.inputTokens, 13);
  assert.equal(result.usage.outputTokens, 24);
});

test("benchmark is dry by default, rejects Sol, and does not load runtime", async () => {
  const options = parseCuratorBenchmarkOptions(["--case", "matter-and-sky"]);
  let loaded = false;
  const report = await runCuratorBenchmark(options, async () => {
    loaded = true;
    throw new Error("must not load");
  });
  assert.equal(report.dryRun, true);
  assert.equal(loaded, false);
  assert.deepEqual(options.models, ["gpt-5.6-terra"]);
  assert.equal(options.deadlineMs, 15750);
  assert.equal(options.maxOutputTokens, 2000);
  assert.equal(options.reasoning, "none");
  assert.equal(
    parseCuratorBenchmarkOptions(["--reasoning", "omit"]).reasoning,
    null,
  );
  assert.throws(
    () => parseCuratorBenchmarkOptions(["--models", "gpt-5.6-sol"]),
    /Sol is excluded/,
  );
});
