/** Server-side experiment instructions. Keep API keys out of these files. */
type Stage = 'draft' | 'curate' | 'write' | 'detail';

/** Appended to the built-in prompt. Start with a small change in one stage. */
export const curationPromptAdditions: Record<Stage, string> = {
  draft: '',
  curate: '',
  write: '',
  detail: '',
};

/** Optional complete replacements. Leave empty to retain the built-in prompts. */
export const curationPromptOverrides: Partial<Record<Stage, string>> = {};
