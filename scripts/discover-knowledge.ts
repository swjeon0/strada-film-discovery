import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "parse5";
import {
  canonicalizeSourceUrl,
  validateRegistry,
  type CollectionJob,
  type CollectionTarget,
  type SourceRegistry,
} from "./collect-knowledge";

type DiscoveryFamily = {
  sourceFamily: string;
  seeds: string[];
  pageStart?: number;
  pageEnd?: number;
  includePathPrefixes: string[];
  quota: number;
  proposedType?: CollectionTarget["proposedType"];
  tags?: string[];
};
export type DiscoveryPlan = {
  version: 1;
  id: string;
  createdAt: string;
  description: string;
  targetDocuments: number;
  families: DiscoveryFamily[];
};

const wait = (milliseconds: number) =>
  new Promise((done) => setTimeout(done, milliseconds));
const slug = (value: string) =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 110);

function linksFromHtml(html: string, base: string) {
  const urls = new Set<string>(),
    walk = (node: unknown) => {
      const value = node as {
        attrs?: { name: string; value: string }[];
        childNodes?: unknown[];
      };
      const href = value.attrs?.find((attribute) => attribute.name === "href")?.value;
      if (href)
        try {
          urls.add(new URL(href, base).href);
        } catch {}
      for (const child of value.childNodes ?? []) walk(child);
    };
  walk(parse(html));
  return [...urls];
}

export function selectDiscovered(
  plan: DiscoveryPlan,
  registry: SourceRegistry,
  pages: Map<string, string>,
  published: Iterable<string> = [],
) {
  const publishedUrls = new Set(
      [...published]
        .map(canonicalizeSourceUrl)
        .filter((value): value is string => Boolean(value)),
    ),
    selected: CollectionTarget[] = [],
    seen = new Set<string>();
  for (const source of plan.families) {
    const family = registry.families.find((value) => value.id === source.sourceFamily);
    if (!family) throw new Error(`Unknown discovery source family: ${source.sourceFamily}`);
    const candidates = new Set<string>();
    for (const [pageUrl, html] of pages)
      if (pageUrl.startsWith(`${source.sourceFamily}:`))
        for (const raw of linksFromHtml(html, pageUrl.slice(source.sourceFamily.length + 1))) {
          const canonical = canonicalizeSourceUrl(raw);
          if (!canonical) continue;
          const url = new URL(canonical);
          if (
            family.hosts.some(
              (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
            ) &&
            source.includePathPrefixes.some((prefix) => url.pathname.startsWith(prefix)) &&
            !publishedUrls.has(canonical) &&
            !seen.has(canonical)
          )
            candidates.add(canonical);
        }
    for (const url of [...candidates].sort().slice(0, source.quota)) {
      const path = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "source",
        digest = createHash("sha256").update(url).digest("hex").slice(0, 10),
        id = `${slug(source.sourceFamily)}-${slug(path) || "source"}-${digest}`;
      selected.push({
        id,
        url,
        sourceFamily: source.sourceFamily,
        proposedType: source.proposedType,
        tags: source.tags,
      });
      seen.add(url);
    }
  }
  return selected.slice(0, plan.targetDocuments);
}

async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

async function existingUrls(root: string) {
  const { readdir } = await import("node:fs/promises"),
    urls: string[] = [];
  for (const file of (await readdir(root)).filter((name) => name.endsWith(".json"))) {
    const rows = JSON.parse(await readFile(resolve(root, file), "utf8")) as {
      url: string;
      verification?: { textUrl?: string };
    }[];
    for (const row of rows) {
      urls.push(row.url);
      if (row.verification?.textUrl) urls.push(row.verification.textUrl);
    }
  }
  return urls;
}

async function main() {
  const args = process.argv.slice(2),
    get = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    },
    planPath = resolve(
      get("--plan") ?? "research/knowledge/collection/discovery/scale-500-2026-09-20.json",
    ),
    plan = JSON.parse(await readFile(planPath, "utf8")) as DiscoveryPlan,
    registry = validateRegistry(
      JSON.parse(
        await readFile(
          resolve(get("--registry") ?? "research/knowledge/collection/sources.json"),
          "utf8",
        ),
      ),
    ),
    output = resolve(
      get("--out") ?? `research/knowledge/collection/jobs/${plan.id}.json`,
    ),
    run = args.includes("--run");
  if (
    plan.version !== 1 ||
    !plan.id ||
    !plan.description ||
    !Number.isInteger(plan.targetDocuments) ||
    plan.targetDocuments < 1 ||
    !Array.isArray(plan.families) ||
    !plan.families.length
  )
    throw new Error("Invalid discovery plan.");
  const listingCount = plan.families.reduce(
    (count, family) =>
      count +
      family.seeds.length *
        ((family.pageEnd ?? family.pageStart ?? 1) - (family.pageStart ?? 1) + 1),
    0,
  );
  if (!run) {
    console.log(
      JSON.stringify({
        dryRun: true,
        id: plan.id,
        targetDocuments: plan.targetDocuments,
        listingRequests: listingCount,
        output,
        hint: "Add --run to fetch listing pages and create a deterministic collection job.",
      }, null, 2),
    );
    return;
  }
  const pages = new Map<string, string>();
  for (const source of plan.families) {
    const family = registry.families.find((value) => value.id === source.sourceFamily)!;
    for (const seed of source.seeds)
      for (
        let page = source.pageStart ?? 1;
        page <= (source.pageEnd ?? source.pageStart ?? 1);
        page++
      ) {
        const url = seed.replace("{page}", String(page)),
          response = await fetch(url, {
            headers: { "User-Agent": "STRADA-research-collector/1.0" },
            signal: AbortSignal.timeout(30_000),
          });
        if (!response.ok) throw new Error(`Discovery failed (${response.status}): ${url}`);
        pages.set(`${source.sourceFamily}:${url}`, await response.text());
        await wait(family.paceMs);
      }
  }
  const targets = selectDiscovered(
    plan,
    registry,
    pages,
    await existingUrls(resolve("research/knowledge/records")),
  );
  if (targets.length < plan.targetDocuments)
    throw new Error(
      `Discovery produced ${targets.length}/${plan.targetDocuments} unpublished targets. Increase source pages or quotas.`,
    );
  const job: CollectionJob = {
    version: 1,
    id: plan.id,
    createdAt: plan.createdAt,
    description: plan.description,
    targets,
  };
  await atomic(output, job);
  console.log(
    JSON.stringify({
      job: job.id,
      targets: targets.length,
      byFamily: Object.fromEntries(
        plan.families.map((source) => [
          source.sourceFamily,
          targets.filter((target) => target.sourceFamily === source.sourceFamily).length,
        ]),
      ),
      output,
    }, null, 2),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Discovery failed.");
    process.exitCode = 1;
  });
