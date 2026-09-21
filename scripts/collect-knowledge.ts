import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readSource,
  sourceUrlAllowed,
  type SourceFetchResult,
} from "./audit-knowledge-sources";

export type SourceType = "criticism" | "academic" | "programme" | "festival";
export type RightsMode =
  | "restricted_excerpt"
  | "open_license"
  | "noncommercial"
  | "metadata_only";
export type SourceFamily = {
  id: string;
  publisher: string;
  hosts: string[];
  allowedPathPrefixes: string[];
  defaultType: SourceType;
  defaultLanguage: string;
  rights: { mode: RightsMode; licenseUrl: string | null; note: string };
  paceMs: number;
  minimumTextChars: number;
};
export type SourceRegistry = { version: 1; families: SourceFamily[] };
export type CollectionTarget = {
  id: string;
  url: string;
  textUrl?: string;
  sourceFamily: string;
  proposedType?: SourceType;
  language?: string;
  titleHint?: string;
  tags?: string[];
  note?: string;
};
export type CollectionJob = {
  version: 1;
  id: string;
  createdAt: string;
  description: string;
  targets: CollectionTarget[];
};
export type CollectionStatus =
  | "fetched"
  | "duplicate_published"
  | "duplicate_in_job"
  | "duplicate_content"
  | "policy_rejected"
  | "invalid_target"
  | Exclude<SourceFetchResult["status"], "readable">;
export type CollectionItem = {
  targetId: string;
  sourceFamily: string;
  url: string;
  canonicalUrl: string | null;
  fetchUrl: string;
  canonicalFetchUrl: string | null;
  status: CollectionStatus;
  publisher?: string;
  proposedType?: SourceType;
  language?: string;
  rights?: SourceFamily["rights"];
  tags?: string[];
  note?: string;
  checkedAt?: string;
  checkedUrl?: string;
  httpStatus?: number | null;
  contentHash?: string | null;
  textHash?: string;
  contentType?: string;
  bytes?: number;
  characters?: number;
  rawTextPath?: string;
  titleHint?: string;
  reason?: string;
};
export type CollectionManifest = {
  version: 1;
  jobId: string;
  jobHash: string;
  generatedAt: string;
  complete: boolean;
  counts: Record<string, number>;
  notes: string[];
  items: CollectionItem[];
};

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const idPattern = /^[a-z0-9][a-z0-9._-]{2,159}$/;
const sourceTypes = new Set<SourceType>([
  "criticism",
  "academic",
  "programme",
  "festival",
]);

export function canonicalizeSourceUrl(raw: string) {
  if (!sourceUrlAllowed(raw)) return null;
  const url = new URL(raw);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()])
    if (/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key))
      url.searchParams.delete(key);
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

export function validateRegistry(value: unknown): SourceRegistry {
  const registry = value as Partial<SourceRegistry>;
  if (registry.version !== 1 || !Array.isArray(registry.families))
    throw new Error("Source registry must be version 1 with a families array.");
  const seen = new Set<string>();
  for (const family of registry.families) {
    if (!family || !idPattern.test(family.id) || seen.has(family.id))
      throw new Error("Source-family IDs must be unique stable slugs.");
    seen.add(family.id);
    if (
      !family.publisher?.trim() ||
      !Array.isArray(family.hosts) ||
      !family.hosts.length ||
      family.hosts.some((host) => !/^[a-z0-9.-]+$/.test(host)) ||
      !Array.isArray(family.allowedPathPrefixes) ||
      !family.allowedPathPrefixes.length ||
      family.allowedPathPrefixes.some((path) => !path.startsWith("/")) ||
      !sourceTypes.has(family.defaultType) ||
      !family.defaultLanguage?.trim() ||
      !family.rights?.note?.trim() ||
      !Number.isInteger(family.paceMs) ||
      family.paceMs < 0 ||
      !Number.isInteger(family.minimumTextChars) ||
      family.minimumTextChars < 80
    )
      throw new Error(`Invalid source-family policy: ${family.id}`);
  }
  return registry as SourceRegistry;
}

export function validateCollectionJob(value: unknown): CollectionJob {
  const job = value as Partial<CollectionJob>;
  if (
    job.version !== 1 ||
    !job.id ||
    !idPattern.test(job.id) ||
    !job.description?.trim() ||
    !job.createdAt ||
    Number.isNaN(Date.parse(job.createdAt)) ||
    !Array.isArray(job.targets) ||
    !job.targets.length
  )
    throw new Error("Invalid collection job.");
  const seen = new Set<string>();
  for (const target of job.targets) {
    if (
      !target ||
      !idPattern.test(target.id) ||
      seen.has(target.id) ||
      !target.url ||
      !target.sourceFamily ||
      (target.proposedType && !sourceTypes.has(target.proposedType)) ||
      (target.tags &&
        (!Array.isArray(target.tags) ||
          target.tags.some((tag) => typeof tag !== "string" || !tag.trim())))
    )
      throw new Error(`Invalid or duplicate collection target: ${target?.id}`);
    seen.add(target.id);
  }
  return job as CollectionJob;
}

function familyAllows(family: SourceFamily, raw: string) {
  const canonical = canonicalizeSourceUrl(raw);
  if (!canonical) return false;
  const url = new URL(canonical);
  return (
    family.hosts.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    ) && family.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix))
  );
}

export function planCollection(
  registry: SourceRegistry,
  job: CollectionJob,
  publishedUrls: Iterable<string> = [],
) {
  const published = new Set(
      [...publishedUrls]
        .map(canonicalizeSourceUrl)
        .filter((url): url is string => Boolean(url)),
    ),
    seen = new Set<string>();
  return job.targets.map((target): CollectionItem => {
    const family = registry.families.find((row) => row.id === target.sourceFamily),
      canonicalUrl = canonicalizeSourceUrl(target.url),
      fetchUrl = target.textUrl ?? target.url,
      canonicalFetchUrl = canonicalizeSourceUrl(fetchUrl),
      base = {
        targetId: target.id,
        sourceFamily: target.sourceFamily,
        url: target.url,
        canonicalUrl,
        fetchUrl,
        canonicalFetchUrl,
        tags: target.tags ?? [],
        note: target.note,
        titleHint: target.titleHint,
      };
    if (!canonicalUrl || !canonicalFetchUrl)
      return {
        ...base,
        status: "invalid_target",
        reason: "Source and text URLs must be public HTTPS URLs.",
      };
    if (!family || !familyAllows(family, target.url) || !familyAllows(family, fetchUrl))
      return {
        ...base,
        status: "policy_rejected",
        reason: "The source family does not allow this host or path.",
      };
    const enriched = {
      ...base,
      publisher: family.publisher,
      proposedType: target.proposedType ?? family.defaultType,
      language: target.language ?? family.defaultLanguage,
      rights: family.rights,
    };
    if (published.has(canonicalUrl) || published.has(canonicalFetchUrl))
      return {
        ...enriched,
        status: "duplicate_published",
        reason: "URL already exists in the published corpus.",
      };
    if (seen.has(canonicalUrl) || seen.has(canonicalFetchUrl))
      return {
        ...enriched,
        status: "duplicate_in_job",
        reason: "Canonical URL repeats an earlier target in this job.",
      };
    seen.add(canonicalUrl);
    seen.add(canonicalFetchUrl);
    return { ...enriched, status: "network_error", reason: "Not fetched yet." };
  });
}

export function summarizeCollection(items: CollectionItem[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await rename(path + ".tmp", path);
}

async function publishedUrls(root: string) {
  const urls: string[] = [];
  for (const name of (await readdir(root)).filter((name) => name.endsWith(".json"))) {
    const records = JSON.parse(await readFile(join(root, name), "utf8")) as {
      url: string;
      verification?: { textUrl?: string };
    }[];
    for (const record of records) {
      urls.push(record.url);
      if (record.verification?.textUrl) urls.push(record.verification.textUrl);
    }
  }
  return urls;
}

function manifestFor(job: CollectionJob, items: CollectionItem[]): CollectionManifest {
  const terminal = new Set([
    "fetched",
    "duplicate_published",
    "duplicate_in_job",
    "duplicate_content",
    "policy_rejected",
    "invalid_target",
    "blocked",
    "http_error",
    "pdf_not_checked",
    "unsupported_content",
    "response_too_large",
    "unreadable",
  ]);
  return {
    version: 1,
    jobId: job.id,
    jobHash: hash(JSON.stringify(job)),
    generatedAt: new Date().toISOString(),
    complete: items.every((item) => terminal.has(item.status)),
    counts: summarizeCollection(items),
    notes: [
      "Fetched means source text was captured in ignored work storage; it is not published evidence.",
      "Publication requires automatic exact-quote checks, independent film identity resolution, schema validation, and the existing corpus build/audit.",
      "Raw publisher text is not committed unless its license explicitly permits redistribution.",
    ],
    items,
  };
}

async function main() {
  const args = process.argv.slice(2),
    get = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    },
    jobPath = resolve(
      get("--job") ?? "research/knowledge/collection/jobs/pilot-scale-2026-09-20.json",
    ),
    registry = validateRegistry(
      JSON.parse(
        await readFile(
          resolve(
            get("--registry") ?? "research/knowledge/collection/sources.json",
          ),
          "utf8",
        ),
      ),
    ),
    job = validateCollectionJob(JSON.parse(await readFile(jobPath, "utf8"))),
    output = resolve(
      get("--out") ??
        `research/knowledge/collection/manifests/${job.id}.json`,
    ),
    refresh = args.includes("--refresh"),
    run = args.includes("--run"),
    concurrency = Math.min(
      8,
      Math.max(1, Number.parseInt(get("--concurrency") ?? "4", 10) || 4),
    ),
    items = planCollection(
      registry,
      job,
      await publishedUrls(resolve("research/knowledge/records")),
    );
  if (!run) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          job: job.id,
          targets: items.length,
          counts: summarizeCollection(items),
          hint: "Add --run to fetch policy-approved, unpublished targets.",
        },
        null,
        2,
      ),
    );
    return;
  }
  let previous: CollectionManifest | undefined;
  try {
    previous = JSON.parse(await readFile(output, "utf8")) as CollectionManifest;
  } catch {}
  const prior = new Map(previous?.items.map((item) => [item.targetId, item]) ?? []),
    families = new Map(registry.families.map((family) => [family.id, family])),
    nextAllowed = new Map<string, number>(),
    seenText = new Map<string, string>(),
    waitForHost = async (host: string, paceMs: number) => {
      const now = Date.now(),
        startAt = Math.max(now, nextAllowed.get(host) ?? 0);
      nextAllowed.set(host, startAt + paceMs);
      if (startAt > now)
        await new Promise((resolveWait) => setTimeout(resolveWait, startAt - now));
    };
  for (const item of previous?.items ?? [])
    if (item.status === "fetched" && item.textHash)
      seenText.set(item.textHash, item.targetId);
  let cursor = 0,
    checkpoint = Promise.resolve();
  const saveCheckpoint = () => {
    checkpoint = checkpoint.then(() => atomic(output, manifestFor(job, items)));
    return checkpoint;
  };
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < items.length) {
        const index = cursor++,
          item = items[index],
          old = prior.get(item.targetId);
        if (
          !refresh &&
          old &&
          !["network_error", "http_error"].includes(old.status) &&
          old.canonicalUrl === item.canonicalUrl
        ) {
          items[index] = old;
          continue;
        }
        if (item.reason !== "Not fetched yet.") continue;
        const family = families.get(item.sourceFamily)!,
          host = new URL(item.fetchUrl).hostname;
        await waitForHost(host, family.paceMs);
        const fetched = await readSource(item.fetchUrl, refresh);
        if (fetched.status !== "readable") {
          items[index] = {
            ...item,
            status: fetched.status,
            checkedAt: fetched.checkedAt,
            checkedUrl: fetched.url,
            httpStatus: fetched.httpStatus,
            contentHash: fetched.contentHash,
            contentType: fetched.contentType,
            bytes: fetched.bytes,
            reason: fetched.reason,
          };
        } else if (fetched.text!.trim().length < family.minimumTextChars) {
          items[index] = {
            ...item,
            status: "unreadable",
            checkedAt: fetched.checkedAt,
            checkedUrl: fetched.url,
            httpStatus: fetched.httpStatus,
            contentHash: fetched.contentHash,
            textHash: fetched.textHash,
            contentType: fetched.contentType,
            bytes: fetched.bytes,
            characters: fetched.text!.length,
            reason: `Extracted text is shorter than the ${family.minimumTextChars}-character source policy minimum.`,
          };
        } else if (
          fetched.textHash &&
          seenText.has(fetched.textHash) &&
          seenText.get(fetched.textHash) !== item.targetId
        ) {
          items[index] = {
            ...item,
            status: "duplicate_content",
            checkedAt: fetched.checkedAt,
            checkedUrl: fetched.url,
            httpStatus: fetched.httpStatus,
            contentHash: fetched.contentHash,
            textHash: fetched.textHash,
            contentType: fetched.contentType,
            bytes: fetched.bytes,
            characters: fetched.text!.length,
            reason: `Extracted text duplicates target ${seenText.get(fetched.textHash)}.`,
          };
        } else {
          const raw = resolve(
            `work/knowledge/collection/${job.id}/text/${fetched.textHash}.txt`,
          );
          if (fetched.textHash) seenText.set(fetched.textHash, item.targetId);
          await mkdir(dirname(raw), { recursive: true });
          await writeFile(raw, fetched.text!);
          items[index] = {
            ...item,
            status: "fetched",
            checkedAt: fetched.checkedAt,
            checkedUrl: fetched.url,
            httpStatus: fetched.httpStatus,
            contentHash: fetched.contentHash,
            textHash: fetched.textHash,
            contentType: fetched.contentType,
            bytes: fetched.bytes,
            characters: fetched.text!.length,
            rawTextPath: relative(process.cwd(), raw),
            reason: undefined,
          };
        }
        await saveCheckpoint();
        console.log(`${item.targetId}: ${items[index].status}`);
      }
    }),
  );
  await checkpoint;
  const manifest = manifestFor(job, items);
  await atomic(output, manifest);
  console.log(
    JSON.stringify({
      job: job.id,
      complete: manifest.complete,
      counts: manifest.counts,
      manifest: relative(process.cwd(), output),
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Collection failed.");
    process.exitCode = 1;
  });
