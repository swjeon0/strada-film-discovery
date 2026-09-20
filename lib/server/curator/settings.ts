import { createHash } from "node:crypto";
import configuration from "../../../config/curation.json";
import {
  curatorPromptAdditions,
  curatorPromptOverrides,
  type CuratorStage,
} from "../../../config/curation-prompts";

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type StageSettings = {
  model: string;
  reasoning: ReasoningEffort | null;
  timeoutMs: number;
  maxOutputTokens: number;
};

type SettingsOptions = { env?: Record<string, string | undefined> };
type ConfigProfile = Record<CuratorStage, StageSettings>;
const stages: CuratorStage[] = ["list", "repair", "detail"];
const envPrefixes: Record<CuratorStage, string> = {
  list: "OPENAI_CURATOR",
  repair: "OPENAI_REPAIR",
  detail: "OPENAI_DETAIL",
};
const efforts = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const nonempty = (value: string | undefined) => value?.trim() || undefined;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export function supportsReasoning(model: string) {
  return /^(?:gpt-[5-9](?:[.\-]|$)|o[134](?:[.\-]|$))/.test(model);
}

function validateEffort(model: string, effort: ReasoningEffort | null) {
  if (effort === null) return;
  const supported = /^gpt-5\.6(?:-|$)/.test(model)
    ? ["none", "low", "medium", "high", "xhigh", "max"]
    : /^gpt-5\.4-mini(?:-|$)/.test(model)
      ? ["none", "low", "medium", "high", "xhigh"]
      : /^gpt-6-astra(?:-|$)/.test(model)
        ? ["low", "medium", "high", "xhigh", "max"]
        : null;
  if (supported && !supported.includes(effort)) {
    throw new Error(`Reasoning effort ${effort} is not supported by ${model}.`);
  }
}

export function curatorSettings(options: SettingsOptions = {}) {
  const env = options.env ?? process.env;
  const profileName =
    nonempty(env.STRADA_PROFILE) ?? configuration.defaultProfile;
  const profiles = configuration.profiles as Record<string, ConfigProfile>;
  if (!Object.prototype.hasOwnProperty.call(profiles, profileName)) {
    throw new Error(`Unknown STRADA_PROFILE: ${profileName}.`);
  }

  const selected = profiles[profileName];
  const configured = {} as Record<CuratorStage, StageSettings>;
  for (const stage of stages) {
    const prefix = envPrefixes[stage];
    const model = nonempty(env[`${prefix}_MODEL`]) ?? selected[stage].model;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model) ||
      /(?:^|[-_.])sol(?:$|[-_.])/i.test(model)
    ) {
      throw new Error(`Invalid model configured for ${stage}.`);
    }
    const configuredEffort =
      nonempty(env[`${prefix}_REASONING`]) ?? selected[stage].reasoning;
    if (
      configuredEffort !== null &&
      !efforts.has(configuredEffort as ReasoningEffort)
    ) {
      throw new Error(`Invalid reasoning effort configured for ${stage}.`);
    }
    const reasoning = supportsReasoning(model)
      ? (configuredEffort as ReasoningEffort | null)
      : null;
    validateEffort(model, reasoning);
    configured[stage] = { ...selected[stage], model, reasoning };
  }

  return {
    profile: profileName,
    stages: configured,
    fingerprint: hash(configured),
  };
}

export function curatorPrompt(stage: CuratorStage, basePrompt: string) {
  const replacement = curatorPromptOverrides[stage];
  const base = replacement === undefined ? basePrompt : replacement;
  if (!base.trim()) throw new Error(`The ${stage} prompt cannot be empty.`);
  const addition = curatorPromptAdditions[stage].trim();
  return addition
    ? `${base}\n\nAdditional curator instructions:\n${addition}`
    : base;
}

export function curatorStageFingerprint(stage: CuratorStage, prompt: string) {
  const settings = curatorSettings().stages[stage];
  return hash({ stage, settings, prompt: curatorPrompt(stage, prompt) });
}
