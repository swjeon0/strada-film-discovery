/** Server-side experiment instructions. Never put credentials in this file. */
export type CuratorStage = "list" | "repair" | "detail";

/** Appended to the built-in prompt for the selected stage. */
export const curatorPromptAdditions: Record<CuratorStage, string> = {
  list: "",
  repair: "",
  detail: "",
};

/** Complete prompt replacements. Leave empty during normal operation. */
export const curatorPromptOverrides: Partial<Record<CuratorStage, string>> = {};
