import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";

const API = "https://api.openai.com/v1";
const wait = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));
type BatchState = {
  version: 1;
  inputSha256: string;
  inputFileId: string;
  batchId: string;
  status: string;
  outputFileId?: string | null;
  errorFileId?: string | null;
  counts?: { total?: number; completed?: number; failed?: number };
  updatedAt: string;
};

async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

async function api(path: string, key: string, init?: RequestInit) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`OpenAI ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}

async function main() {
  nextEnv.loadEnvConfig(process.cwd());
  const args = process.argv.slice(2),
    get = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    },
    input = resolve(get("--input") ?? "work/knowledge/collection/scale-500-2026-09-20/batch-input.jsonl"),
    output = resolve(get("--out") ?? "work/knowledge/collection/scale-500-2026-09-20/batch-output.jsonl"),
    statePath = resolve(get("--state") ?? "work/knowledge/collection/scale-500-2026-09-20/batch-state.json"),
    pollMs = Math.max(10_000, Number.parseInt(get("--poll-ms") ?? "15000", 10)),
    run = args.includes("--run"),
    key = process.env.OPENAI_API_KEY,
    contents = await readFile(input),
    sha256 = createHash("sha256").update(contents).digest("hex"),
    requests = contents.toString("utf8").split(/\n+/).filter(Boolean).length;
  if (!run) {
    console.log(JSON.stringify({ dryRun: true, requests, bytes: contents.length, input, output, statePath }, null, 2));
    return;
  }
  if (!key) throw new Error("OPENAI_API_KEY is required.");
  let state: BatchState | undefined;
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8")) as BatchState;
    if (saved.inputSha256 === sha256) state = saved;
  } catch {}
  if (!state) {
    const form = new FormData();
    form.set("purpose", "batch");
    form.set("file", new Blob([contents], { type: "application/jsonl" }), "strada-knowledge.jsonl");
    const uploaded = (await (await api("/files", key, { method: "POST", body: form })).json()) as { id: string };
    const batch = (await (
      await api("/batches", key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_file_id: uploaded.id,
          endpoint: "/v1/responses",
          completion_window: "24h",
          metadata: { purpose: "strada_knowledge_extraction" },
        }),
      })
    ).json()) as { id: string; status: string };
    state = {
      version: 1,
      inputSha256: sha256,
      inputFileId: uploaded.id,
      batchId: batch.id,
      status: batch.status,
      updatedAt: new Date().toISOString(),
    };
    await atomic(statePath, state);
    console.log(JSON.stringify({ event: "submitted", batchId: state.batchId, requests, bytes: contents.length }));
  }
  let last = "";
  while (true) {
    const batch = (await (await api(`/batches/${state.batchId}`, key)).json()) as {
      status: string;
      output_file_id?: string | null;
      error_file_id?: string | null;
      request_counts?: { total?: number; completed?: number; failed?: number };
      errors?: unknown;
    };
    state = {
      ...state,
      status: batch.status,
      outputFileId: batch.output_file_id,
      errorFileId: batch.error_file_id,
      counts: batch.request_counts,
      updatedAt: new Date().toISOString(),
    };
    await atomic(statePath, state);
    const progress = JSON.stringify({ status: state.status, counts: state.counts });
    if (progress !== last) {
      console.log(progress);
      last = progress;
    }
    if (state.status === "completed") break;
    if (["failed", "expired", "cancelled"].includes(state.status))
      throw new Error(`Batch ended with status ${state.status}.`);
    await wait(pollMs);
  }
  if (!state.outputFileId) throw new Error("Completed batch has no output file.");
  const result = Buffer.from(await (await api(`/files/${state.outputFileId}/content`, key)).arrayBuffer());
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, result);
  console.log(JSON.stringify({ event: "downloaded", output, bytes: result.length, counts: state.counts }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Batch run failed.");
    process.exitCode = 1;
  });
