// A display boundary, not a JSON repair parser. Film prose must never expose
// serialized recommendation fields. Offsets refer to the untouched input.
const schemaKeys = [
  "sourceIds",
  "sourceId",
  "sourceIndices",
  "contextSourceIndices",
  "sources",
  "candidates",
  "connections",
  "anchorId",
  "anchorIndex",
  "anchorTitle",
  "inferenceWhy",
  "inferenceWhyKo",
  "whyKo",
  "reasonKo",
  "filmForm",
  "watchFor",
  "verifiedCriticalSources",
  "knownConnections",
  "knownSources",
].join("|");
const quote = String.raw`(?:\\*["'“”‘’]|\\u(?:0022|0027|201[89cd]))`;
const space = String.raw`(?:\s|\\[nrt])*`;
const quotedField = new RegExp(
  `${quote}${space}(?:${schemaKeys})${space}${quote}${space}(?::|：|\\\\u003[aA])`,
  "iu",
);
const unquotedField = new RegExp(
  String.raw`[}\],{]${space}(?:${schemaKeys})${space}:`,
  "iu",
);
const closingTail = /(?:\\*["”’]\s*)?[}\]]\s*(?:,?\s*[}\]])+(?:\s*[,;])?\s*$/u;

function completeStructuredValue(text: string): boolean {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  if (!/^[{[]/u.test(trimmed)) return false;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}

function artifactOffset(text: string): number {
  if (completeStructuredValue(text)) return 0;
  const offsets = [
    quotedField.exec(text)?.index,
    unquotedField.exec(text)?.index,
    closingTail.exec(text)?.index,
  ].filter((i): i is number => i !== undefined);
  return offsets.length ? Math.min(...offsets) : -1;
}

export function hasStructuredArtifact(text: string): boolean {
  return artifactOffset(text) >= 0;
}

function trimArtifactBoundary(text: string): string {
  let result = text;
  // Only remove container punctuation at the boundary of an identified artifact.
  // Keep a balanced human quotation, including its closing quotation mark.
  for (let i = 0; i < 4; i++) {
    const before = result;
    result = result.replace(/(?:\s|\\[nrt]|[,:[\]{}])+$/gu, "");
    result = result.replace(/\\u(?:0022|0027|201[89cd])$/iu, "");
    if (
      result.endsWith("”") &&
      (result.match(/”/gu)?.length ?? 0) > (result.match(/“/gu)?.length ?? 0)
    ) {
      result = result.slice(0, -1).replace(/\\+$/u, "");
    } else if (
      result.endsWith("’") &&
      (result.match(/’/gu)?.length ?? 0) > (result.match(/‘/gu)?.length ?? 0)
    ) {
      result = result.slice(0, -1).replace(/\\+$/u, "");
    } else if (
      result.endsWith('"') &&
      (result.match(/(?<!\\)"/gu)?.length ?? 0) % 2 === 1
    ) {
      result = result.slice(0, -1).replace(/\\+$/u, "");
    } else if (/\\+"$/u.test(result)) {
      result = result.replace(/\\+"$/u, "");
    }
    if (result === before) break;
  }
  return result.trim();
}

export function cleanDisplayProse(text: string): string {
  const at = artifactOffset(text);
  if (at < 0) return text.trim();
  // An all-data value produces an empty string so the caller can use a clean
  // alternate language/part, or a short human-readable unavailable message.
  return trimArtifactBoundary(text.slice(0, at));
}
