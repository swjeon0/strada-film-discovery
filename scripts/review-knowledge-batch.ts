import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { normalizeQuote } from "./audit-knowledge-sources";
import type { CollectionManifest } from "./collect-knowledge";

const Candidate = z.object({
  admit: z.boolean(),
  accessAssessment: z.enum([
    "full_text",
    "abstract_only",
    "metadata_only",
    "uncertain",
  ]),
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
  ),
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
      filmIndexes: z.array(z.number().int()),
      summary: z.string(),
      boundary: z.string(),
      subjects: z.array(z.string()),
      anchorQuote: z.string(),
      confidence: z.number(),
      reviewFlags: z.array(z.string()),
    }),
  ),
  rejectionReasons: z.array(z.string()),
});

export function extractResponseText(body: unknown) {
  const value = body as {
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  };
  return value.output
    ?.flatMap((item) => item.content ?? [])
    .find((part) => part.type === "output_text")?.text;
}

export function auditCandidate(candidate: z.infer<typeof Candidate>, sourceText: string) {
  const academicAbstract =
      candidate.document.sourceType === "academic" &&
      candidate.accessAssessment !== "full_text",
    observations = candidate.observations.map((observation) => {
      const quote = normalizeQuote(observation.anchorQuote),
        quoteMatched = Boolean(quote) && normalizeQuote(sourceText).includes(quote),
        quoteWords = observation.anchorQuote.trim().split(/\s+/).filter(Boolean).length,
        filmIndexesValid = observation.filmIndexes.every(
          (index) => index >= 0 && index < candidate.films.length,
        );
      return {
        ...observation,
        quoteMatched,
        quoteWords,
        filmIndexesValid,
        eligibleForReview:
          quoteMatched && quoteWords <= 25 && filmIndexesValid && !academicAbstract,
      };
    });
  return {
    ...candidate,
    admit: candidate.admit && !academicAbstract,
    automaticBlocks: [
      ...(academicAbstract ? ["academic_without_full_text"] : []),
      ...(observations.some((row) => !row.quoteMatched)
        ? ["quote_not_found"]
        : []),
      ...(observations.some((row) => row.quoteWords > 25)
        ? ["quote_over_25_words"]
        : []),
      ...(observations.some((row) => !row.filmIndexesValid)
        ? ["invalid_film_reference"]
        : []),
    ],
    observations,
  };
}

async function main() {
  const args = process.argv.slice(2),
    get = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    },
    manifestPath = resolve(
      get("--manifest") ??
        "research/knowledge/collection/manifests/pilot-scale-2026-09-20.json",
    ),
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CollectionManifest,
    resultPath = resolve(
      get("--results") ??
        `work/knowledge/collection/${manifest.jobId}/batch-output.jsonl`,
    ),
    output = resolve(
      get("--out") ??
        `work/knowledge/collection/${manifest.jobId}/review-candidates.json`,
    ),
    items = new Map(manifest.items.map((item) => [item.targetId, item])),
    reviewed: unknown[] = [];
  for (const line of (await readFile(resultPath, "utf8")).split(/\n+/).filter(Boolean)) {
    const result = JSON.parse(line) as {
      custom_id: string;
      response?: { status_code?: number; body?: unknown };
      error?: unknown;
    };
    const match = result.custom_id.match(/^(.*?)__(.*?)__c(\d+)$/),
      target = match ? items.get(match[2]) : undefined;
    if (!match || !target?.rawTextPath) {
      reviewed.push({ customId: result.custom_id, status: "unmatched_result" });
      continue;
    }
    const responseText = extractResponseText(result.response?.body);
    if (result.response?.status_code !== 200 || !responseText) {
      reviewed.push({
        customId: result.custom_id,
        targetId: target.targetId,
        status: "api_error",
        apiError: result.error ?? null,
      });
      continue;
    }
    try {
      const parsed = Candidate.parse(JSON.parse(responseText)),
        sourceText = await readFile(resolve(target.rawTextPath), "utf8");
      reviewed.push({
        customId: result.custom_id,
        targetId: target.targetId,
        chunk: Number(match[3]),
        status: "needs_review",
        source: {
          url: target.url,
          checkedUrl: target.checkedUrl,
          sourceFamily: target.sourceFamily,
          textHash: target.textHash,
        },
        candidate: auditCandidate(parsed, sourceText),
      });
    } catch (error) {
      reviewed.push({
        customId: result.custom_id,
        targetId: target.targetId,
        status: "invalid_model_output",
        reason: error instanceof Error ? error.message : "Invalid output",
      });
    }
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        version: 1,
        jobId: manifest.jobId,
        generatedAt: new Date().toISOString(),
        status: "untrusted_candidates_only",
        note: "Review against the original source. This file cannot be imported by the production corpus builder.",
        items: reviewed,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ job: manifest.jobId, candidates: reviewed.length, output }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Review failed.");
    process.exitCode = 1;
  });
