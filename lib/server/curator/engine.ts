import type { Film, Language } from "../../domain";
import { sumUsage } from "./usage";
import type { KnowledgeRepository } from "../knowledge/repository";
import {
  curateOnce,
  repairCuratorOnce,
  type CuratorCallOptions,
  type CuratorCallResult,
} from "./model";
import {
  CuratorIdentityError,
  createResolutionSession,
  resolveCuratorOutput,
  type ProposalResolver,
} from "./resolve";
import type { CuratorDecision, CuratorRequest } from "./contract";

export type CuratorProgress = {
  stage: "metadata" | "context" | "curating" | "verifying" | "repairing";
  completed?: number;
  total?: number;
};

export type CuratorRun = {
  decision: CuratorDecision;
  contextFingerprint: string;
  contextPassageCount: number;
  contextCoverage: Record<string, number>;
  model: string;
  usage: CuratorCallResult["usage"];
  repair: { attempted: boolean; model?: string; indexes?: number[] };
  timings: {
    contextMs: number;
    modelMs: number;
    resolveMs: number;
    repairMs: number;
    totalMs: number;
  };
};
export type CuratorEngineInput = {
  selected: Film[];
  excludedIds: string[];
  forbiddenFilms?: Pick<Film, "id" | "title" | "year" | "director">[];
  language: Language;
  repository: KnowledgeRepository;
  options: CuratorCallOptions;
  signal: AbortSignal;
  onProgress?: (progress: CuratorProgress) => void;
};
export type CuratorDependencies = {
  curate: typeof curateOnce;
  repair: typeof repairCuratorOnce;
  resolve: typeof resolveCuratorOutput;
};

export async function runCurator(
  input: CuratorEngineInput,
  dependencies: Partial<CuratorDependencies> = {},
  resolver?: ProposalResolver,
): Promise<CuratorRun> {
  const deps: CuratorDependencies = {
    curate: curateOnce,
    repair: repairCuratorOnce,
    resolve: resolveCuratorOutput,
    ...dependencies,
  };
  const started = Date.now(),
    contextStarted = Date.now();
  const context = await input.repository.buildContext(
      input.selected,
      input.language,
    ),
    contextMs = Date.now() - contextStarted;
  const request: CuratorRequest = {
    selected: input.selected,
    excludedIds: [
      ...new Set([
        ...input.excludedIds,
        ...input.selected.map((film) => film.id),
      ]),
    ],
    forbiddenFilms: input.forbiddenFilms,
    language: input.language,
    context,
  };
  let generationFinished = false, verified = 0;
  const identities = createResolutionSession(input.signal, resolver, (completed) => {
    verified = Math.min(12, completed);
    input.onProgress?.({
      stage: generationFinished ? "verifying" : "curating",
      completed: verified,
      total: 12,
    });
  });
  input.onProgress?.({ stage: "curating", completed: 0, total: 12 });
  const result = await deps.curate(
    request, input.options, input.signal, undefined, identities.warm,
  );
  generationFinished = true;
  input.onProgress?.({ stage: "verifying", completed: verified, total: 12 });
  let output = result.output,
    usage = result.usage,
    repairMs = 0,
    repair: { attempted: boolean; model?: string; indexes?: number[] } = {
      attempted: false,
    };
  const resolveStarted = Date.now();
  let decision: CuratorDecision;
  try {
    decision = await deps.resolve(
      output,
      request.excludedIds,
      input.signal,
      identities.resolve,
    );
  } catch (error) {
    if (
      !(error instanceof CuratorIdentityError) ||
      !input.options.repair ||
      !error.details.invalidIndexes.length
    )
      throw error;
    input.onProgress?.({ stage: "repairing" });
    const repairStarted = Date.now(),
      fixed = await deps.repair(
        request,
        output,
        error.details.invalidIndexes,
        input.options.repair,
        input.signal,
      );
    repairMs = Date.now() - repairStarted;
    output = fixed.output;
    usage = sumUsage(usage, fixed.usage);
    repair = {
      attempted: true,
      model: fixed.model,
      indexes: error.details.invalidIndexes,
    };
    decision = await deps.resolve(
      output,
      request.excludedIds,
      input.signal,
      identities.resolve,
    );
  }
  const resolveMs = Date.now() - resolveStarted - repairMs;
  const contextCoverage = Object.fromEntries(
    input.selected.map((film) => [
      film.id,
      context.passages.filter((passage) => passage.filmIds.includes(film.id))
        .length,
    ]),
  );
  return {
    decision,
    contextFingerprint: input.repository.fingerprint(),
    contextPassageCount: context.passages.length,
    contextCoverage,
    model: result.model,
    usage,
    repair,
    timings: {
      contextMs,
      modelMs: result.elapsedMs,
      resolveMs,
      repairMs,
      totalMs: Date.now() - started,
    },
  };
}
