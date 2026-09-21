import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CollectionManifest } from "./collect-knowledge";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["admit", "accessAssessment", "document", "films", "observations", "rejectionReasons"],
  properties: {
    admit: { type: "boolean" },
    accessAssessment: {
      type: "string",
      enum: ["full_text", "abstract_only", "metadata_only", "uncertain"],
    },
    document: {
      type: "object",
      additionalProperties: false,
      required: ["title", "author", "publishedAt", "language", "sourceType"],
      properties: {
        title: { type: ["string", "null"] },
        author: { type: ["string", "null"] },
        publishedAt: { type: ["string", "null"] },
        language: { type: "string" },
        sourceType: {
          type: "string",
          enum: ["criticism", "academic", "programme", "festival"],
        },
      },
    },
    films: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "year", "director", "aliases", "evidencePhrase"],
        properties: {
          title: { type: "string" },
          year: { type: ["integer", "null"] },
          director: { type: ["string", "null"] },
          aliases: { type: "array", items: { type: "string" } },
          evidencePhrase: { type: "string" },
        },
      },
    },
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "filmIndexes",
          "summary",
          "summaryKo",
          "boundary",
          "subjects",
          "anchorQuote",
          "confidence",
        ],
        properties: {
          kind: {
            type: "string",
            enum: [
              "film_reading",
              "comparison",
              "contrast",
              "influence",
              "co_programming",
              "historical_context",
              "incidental_mention",
            ],
          },
          filmIndexes: { type: "array", minItems: 1, items: { type: "integer" } },
          summary: { type: "string" },
          summaryKo: { type: "string" },
          boundary: { type: "string" },
          subjects: { type: "array", minItems: 1, items: { type: "string" } },
          anchorQuote: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
    rejectionReasons: { type: "array", items: { type: "string" } },
  },
} as const;

export function chunkText(text: string, limit = 36_000, overlap = 1_200) {
  if (limit < 2_000 || overlap < 0 || overlap >= limit)
    throw new Error("Invalid chunk limits.");
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n\n", end);
      if (paragraph > start + Math.floor(limit * 0.65)) end = paragraph;
    }
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function batchLine(
  customId: string,
  model: string,
  source: {
    url: string;
    publisher: string;
    proposedType: string;
    language: string;
    titleHint?: string;
    text: string;
  },
) {
  if (/sol/i.test(model)) throw new Error("Sol models are disabled for STRADA.");
  const instructions = [
    "You extract structured evidence from one actually fetched film-critical source.",
    "Use the supplied text for every interpretation and relationship. You may normalize film title, release year, and director from reliable film knowledge because STRADA independently resolves every film against TMDB before publication; use null when uncertain.",
    "A film mention is useful only when the text gives a concrete reading or a documented relation. Co-mention alone is incidental_mention, not comparison or influence.",
    "Return at most six films and at most three observations, selecting the source's most useful curatorial evidence. Each anchorQuote must occur verbatim in the supplied text and contain at most 20 words. Keep English and Korean summaries precise and boundaries explicit.",
    "For academic material, set admit=false unless this is accessed full text rather than an abstract or metadata page.",
    "Do not claim source support beyond the exact passage. Automatic validators will reject malformed, unverifiable, or nonexistent-film output.",
  ].join(" ");
  return {
    custom_id: customId,
    method: "POST",
    url: "/v1/responses",
    body: {
      model,
      store: false,
      max_output_tokens: 2400,
      reasoning: { effort: "low" },
      instructions,
      input: `Publisher: ${source.publisher}\nCanonical URL: ${source.url}\nProposed source type: ${source.proposedType}\nLanguage hint: ${source.language}\nTitle hint: ${source.titleHint ?? "unknown"}\n\nSOURCE TEXT\n${source.text}`,
      text: {
        format: {
          type: "json_schema",
          name: "strada_source_extraction_candidate",
          strict: true,
          schema,
        },
      },
    },
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
    model = get("--model") ?? "gpt-5.6-terra",
    output = resolve(
      get("--out") ??
        `work/knowledge/collection/${manifest.jobId}/batch-input.jsonl`,
    ),
    rows: ReturnType<typeof batchLine>[] = [];
  if (/sol/i.test(model)) throw new Error("Sol models are disabled for STRADA.");
  for (const item of manifest.items.filter((row) => row.status === "fetched")) {
    if (!item.rawTextPath || !item.publisher || !item.proposedType || !item.language)
      throw new Error(`Fetched item ${item.targetId} lacks collection provenance.`);
    const text = await readFile(resolve(item.rawTextPath), "utf8"),
      bounded =
        text.length <= 24_000
          ? text
          : `${text.slice(0, 18_000)}\n\n[... middle omitted ...]\n\n${text.slice(-6_000)}`;
    rows.push(
        batchLine(`${manifest.jobId}__${item.targetId}`, model, {
          url: item.canonicalUrl!,
          publisher: item.publisher,
          proposedType: item.proposedType,
          language: item.language,
          titleHint: item.titleHint,
          text: bounded,
        }),
      );
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const bytes = Buffer.byteLength(await readFile(output));
  if (rows.length > 50_000 || bytes > 200_000_000)
    throw new Error("Batch exceeds OpenAI Batch API file limits; split the job.");
  console.log(
    JSON.stringify(
      {
        job: manifest.jobId,
        requests: rows.length,
        bytes,
        sha256: createHash("sha256")
          .update(await readFile(output))
          .digest("hex"),
        model,
        output,
        submitted: false,
        note: "Ready for the automated Batch runner. The validator still requires exact quote matches, valid references, non-abstract academic access, and independently resolved films.",
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Batch preparation failed.");
    process.exitCode = 1;
  });
