import assert from "node:assert/strict";
import test from "node:test";
import {
  curatorPrompt,
  curatorSettings,
  supportsReasoning,
} from "../lib/server/curator/settings";

test("balanced settings describe the production list, repair, and detail calls", () => {
  const settings = curatorSettings({ env: {} });
  assert.equal(settings.profile, "balanced");
  assert.deepEqual(settings.stages, {
    list: {
      model: "gpt-5.6-terra",
      reasoning: "none",
      timeoutMs: 15750,
      maxOutputTokens: 2000,
    },
    repair: {
      model: "gpt-5.4",
      reasoning: "none",
      timeoutMs: 3750,
      maxOutputTokens: 1100,
    },
    detail: {
      model: "gpt-5.4-mini",
      reasoning: "low",
      timeoutMs: 30000,
      maxOutputTokens: 2500,
    },
  });
  assert.equal(
    curatorSettings({ env: { STRADA_PROFILE: "baseline" } }).stages.list.model,
    "gpt-5.4-mini",
  );
});

test("stage environment overrides are validated before a paid request", () => {
  const settings = curatorSettings({
    env: {
      OPENAI_CURATOR_MODEL: "gpt-5.4-mini",
      OPENAI_CURATOR_REASONING: "low",
      OPENAI_REPAIR_MODEL: "gpt-4.1-mini",
      OPENAI_DETAIL_REASONING: "none",
    },
  });
  assert.deepEqual(settings.stages.list, {
    model: "gpt-5.4-mini",
    reasoning: "low",
    timeoutMs: 15750,
    maxOutputTokens: 2000,
  });
  assert.equal(settings.stages.repair.reasoning, null);
  assert.equal(settings.stages.detail.reasoning, "none");
  assert.throws(
    () => curatorSettings({ env: { STRADA_PROFILE: "missing" } }),
    /Unknown STRADA_PROFILE/,
  );
  assert.throws(
    () => curatorSettings({ env: { OPENAI_CURATOR_MODEL: "gpt-5.6-sol" } }),
    /Invalid model/,
  );
  assert.throws(
    () => curatorSettings({ env: { OPENAI_CURATOR_REASONING: "minimal" } }),
    /Invalid reasoning effort/,
  );
  assert.equal(supportsReasoning("gpt-5.6-terra"), true);
  assert.equal(supportsReasoning("gpt-4.1-mini"), false);
});

test("prompt helper preserves a built-in prompt when no experiment override is configured", () => {
  assert.equal(curatorPrompt("list", "BASE PROMPT"), "BASE PROMPT");
});
