import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeSourceUrl,
  planCollection,
  summarizeCollection,
  validateCollectionJob,
  validateRegistry,
  type CollectionJob,
  type SourceRegistry,
} from "../scripts/collect-knowledge";
import { batchLine, chunkText } from "../scripts/prepare-knowledge-batch";
import { auditCandidate } from "../scripts/review-knowledge-batch";

const registry: SourceRegistry = {
  version: 1,
  families: [
    {
      id: "archive",
      publisher: "Archive",
      hosts: ["archive.org"],
      allowedPathPrefixes: ["/film/"],
      defaultType: "programme",
      defaultLanguage: "en",
      rights: { mode: "restricted_excerpt", licenseUrl: null, note: "Test policy." },
      paceMs: 1,
      minimumTextChars: 80,
    },
  ],
};
const job: CollectionJob = {
  version: 1,
  id: "batch-001",
  createdAt: "2026-09-20T00:00:00Z",
  description: "Synthetic collection test.",
  targets: [
    { id: "fresh", url: "https://archive.org/film/a?utm_source=x", sourceFamily: "archive" },
    { id: "repeat", url: "https://archive.org/film/a", sourceFamily: "archive" },
    { id: "published", url: "https://archive.org/film/b", sourceFamily: "archive" },
    { id: "wrong-path", url: "https://archive.org/other/c", sourceFamily: "archive" },
  ],
};

test("collector canonicalizes trackers and separates duplicate, published, and policy-rejected targets", () => {
  assert.equal(canonicalizeSourceUrl(job.targets[0].url), "https://archive.org/film/a");
  const plan = planCollection(registry, job, ["https://archive.org/film/b/"]);
  assert.deepEqual(
    plan.map((item) => item.status),
    ["network_error", "duplicate_in_job", "duplicate_published", "policy_rejected"],
  );
  assert.deepEqual(summarizeCollection(plan), {
    network_error: 1,
    duplicate_in_job: 1,
    duplicate_published: 1,
    policy_rejected: 1,
  });
});

test("collector rejects unsafe registries and malformed jobs before fetching", () => {
  assert.equal(validateRegistry(registry).families[0].id, "archive");
  assert.equal(validateCollectionJob(job).id, "batch-001");
  assert.throws(() =>
    validateCollectionJob({ ...job, targets: [job.targets[0], job.targets[0]] }),
  );
  assert.throws(() =>
    validateRegistry({
      ...registry,
      families: [{ ...registry.families[0], allowedPathPrefixes: ["film"] }],
    }),
  );
});

test("batch preparation chunks deterministically and refuses Sol models", () => {
  const text = `${"a".repeat(2100)}\n\n${"b".repeat(2100)}`;
  const chunks = chunkText(text, 2500, 200);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].length <= 2500);
  assert.throws(() =>
    batchLine("id", "gpt-5.6-sol", {
      url: "https://archive.org/film/a",
      publisher: "Archive",
      proposedType: "programme",
      language: "en",
      text: "source",
    }),
  );
});

test("candidate audit blocks abstract-only scholarship and unverifiable quote anchors", () => {
  const candidate = {
    admit: true,
    accessAssessment: "abstract_only" as const,
    document: {
      title: "Paper",
      author: "Scholar",
      publishedAt: null,
      language: "en",
      sourceType: "academic" as const,
    },
    films: [
      { title: "Film", year: 2000, director: "Director", aliases: [], evidencePhrase: "Film" },
    ],
    observations: [
      {
        kind: "film_reading" as const,
        filmIndexes: [0],
        summary: "Reading",
        boundary: "Limited",
        subjects: ["form"],
        anchorQuote: "Words not in the source",
        confidence: 0.8,
        reviewFlags: [],
      },
    ],
    rejectionReasons: [],
  };
  const audited = auditCandidate(candidate, "Different source text.");
  assert.equal(audited.admit, false);
  assert.deepEqual(audited.automaticBlocks, [
    "academic_without_full_text",
    "quote_not_found",
  ]);
  assert.equal(audited.observations[0].eligibleForReview, false);
});
