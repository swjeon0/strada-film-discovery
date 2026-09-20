export type ModelUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  estimatedUsd: number;
  cachedInputTokens?: number;
  estimatedSearchContentTokens?: number;
  cached?: boolean;
};

type UsageResponse = {
  model?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
  };
  output?: { type?: unknown }[];
};

const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export const emptyUsage = (model = "unknown"): ModelUsage => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  searchCalls: 0,
  estimatedUsd: 0,
});

export function responseUsage(
  data: UsageResponse,
  fallbackModel: string,
): ModelUsage {
  const model = typeof data.model === "string" ? data.model : fallbackModel;
  const inputTokens = amount(data.usage?.input_tokens);
  const outputTokens = amount(data.usage?.output_tokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    amount(data.usage?.input_tokens_details?.cached_tokens),
  );
  const searchCalls = (data.output ?? []).filter(
    (item) => item?.type === "web_search_call",
  ).length;
  const [inputRate, cachedRate, outputRate] = model.includes("5.6-terra")
    ? [2, 0.2, 12]
    : model.includes("5.6-luna")
      ? [0.2, 0.02, 1.2]
      : model.includes("5.4-mini")
        ? [0.75, 0.075, 4.5]
        : model.includes("5.4")
          ? [2.5, 0.25, 15]
          : model.includes("4.1-mini")
            ? [0.4, 0.1, 1.6]
            : [0.15, 0.075, 0.6];
  const fixedSearchTokens = /4(?:o|\.1)-mini/.test(model)
    ? searchCalls * 8000
    : 0;
  const estimatedSearchContentTokens =
    inputTokens < fixedSearchTokens ? fixedSearchTokens : 0;

  return {
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    estimatedSearchContentTokens,
    searchCalls,
    estimatedUsd:
      ((inputTokens - cachedInputTokens + estimatedSearchContentTokens) *
        inputRate +
        cachedInputTokens * cachedRate +
        outputTokens * outputRate) /
        1_000_000 +
      searchCalls * 0.01,
  };
}

export function sumUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  const leftEmpty =
    !left.inputTokens && !left.outputTokens && !left.searchCalls;
  const rightEmpty =
    !right.inputTokens && !right.outputTokens && !right.searchCalls;
  const model = leftEmpty
    ? right.model
    : rightEmpty || left.model === right.model
      ? left.model
      : [
          ...new Set([...left.model.split(" + "), ...right.model.split(" + ")]),
        ].join(" + ");

  return {
    model,
    cached: left.cached && right.cached ? true : undefined,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens:
      (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    estimatedSearchContentTokens:
      (left.estimatedSearchContentTokens ?? 0) +
      (right.estimatedSearchContentTokens ?? 0),
    searchCalls: left.searchCalls + right.searchCalls,
    estimatedUsd: left.estimatedUsd + right.estimatedUsd,
  };
}
