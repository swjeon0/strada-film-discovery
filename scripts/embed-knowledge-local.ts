import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { KnowledgeIndex, SemanticNeighbors } from "../lib/server/knowledge/types";
import { embeddingRows, nearestNeighbors } from "./embed-knowledge";

const MODEL = "local-hashed-tfidf-v1",
  DIMENSIONS = 512;

function features(text: string) {
  const normalized = text.normalize("NFKC").toLowerCase(),
    words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [],
    compact = normalized.replace(/\s+/g, " "),
    output: string[] = [];
  for (const word of words) output.push(`w:${word}`);
  for (let index = 0; index + 1 < words.length; index++)
    output.push(`b:${words[index]}_${words[index + 1]}`);
  for (let index = 0; index + 3 <= compact.length; index++) {
    const gram = compact.slice(index, index + 3);
    if (!/^\s+$/.test(gram)) output.push(`c:${gram}`);
  }
  return output;
}

function fnv(value: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashedTfidf(rows: { id: string; text: string }[]) {
  const terms = rows.map((row) => features(row.text)),
    documentFrequency = new Map<string, number>();
  for (const row of terms)
    for (const term of new Set(row))
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  return rows.map((row, rowIndex) => {
    const counts = new Map<string, number>();
    for (const term of terms[rowIndex]) counts.set(term, (counts.get(term) ?? 0) + 1);
    const vector = Array.from({ length: DIMENSIONS }, () => 0);
    for (const [term, count] of counts) {
      const idf = Math.log((rows.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1,
        weight = (1 + Math.log(count)) * idf,
        bucket = fnv(term, 2166136261) % DIMENSIONS,
        sign = fnv(term, 3339675911) & 1 ? 1 : -1;
      vector[bucket] += sign * weight;
    }
    return { id: row.id, vector };
  });
}

async function atomic(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

async function main() {
  const index = JSON.parse(
      await readFile(resolve("research/knowledge/serving-index.json"), "utf8"),
    ) as KnowledgeIndex,
    rows = embeddingRows(index),
    vectors = hashedTfidf(rows),
    neighbors = nearestNeighbors(vectors),
    artifact: SemanticNeighbors = {
      version: 1,
      corpusVersion: index.corpusVersion,
      model: MODEL,
      dimensions: DIMENSIONS,
      neighbors,
    },
    edges = Object.values(neighbors).reduce((total, values) => total + values.length, 0);
  await atomic(resolve("research/knowledge/semantic-neighbors.json"), artifact);
  await atomic(resolve("work/knowledge/local-embedding-run.json"), {
    at: new Date().toISOString(),
    corpusVersion: index.corpusVersion,
    documents: index.documents.length,
    observations: rows.length,
    model: MODEL,
    dimensions: DIMENSIONS,
    semanticEdges: edges,
    apiCalls: 0,
  });
  console.log(
    JSON.stringify({
      documents: index.documents.length,
      observations: rows.length,
      model: MODEL,
      dimensions: DIMENSIONS,
      semanticEdges: edges,
      apiCalls: 0,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Local embedding failed.");
    process.exitCode = 1;
  });
