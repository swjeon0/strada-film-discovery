import { AppError } from "../config";

export type ProposalIdentity = { title: string; year: number; director: string };

/** Observe complete rows only. Partial JSON is never accepted as a programme. */
export function proposalObserver(onProposal?: (proposal: ProposalIdentity) => void) {
  let text = "", cursor = 0, start = -1, depth = 0,
    inString = false, escaped = false, inRows = false, ended = false;
  return (delta: string) => {
    text += delta;
    if (!onProposal || ended) return;
    if (!inRows) {
      const match = /"r"\s*:\s*\[/.exec(text);
      if (!match) return;
      cursor = match.index + match[0].length;
      inRows = true;
    }
    for (; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "{" || char === "[") {
        if (depth === 0 && char === "{") start = cursor;
        depth++;
      } else if (char === "}" || char === "]") {
        if (depth === 0) { ended = true; break; }
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            const row = JSON.parse(text.slice(start, cursor + 1));
            if (typeof row.t === "string" && row.t.length > 0 && row.t.length <= 240 &&
                Number.isInteger(row.y) && row.y >= 1888 && row.y <= 2100 &&
                typeof row.d === "string" && row.d.length > 0 && row.d.length <= 240)
              onProposal({ title: row.t, year: row.y, director: row.d });
          } catch { /* The final strict schema validates malformed rows. */ }
          start = -1;
        }
      }
    }
  };
}

/** Responses SSE events can split at any UTF-8 byte or JSON boundary. */
export async function readResponsesStream<T>(
  response: Response,
  signal: AbortSignal,
  onText: (delta: string) => void,
): Promise<T> {
  if (!response.body)
    throw new AppError("INCOMPLETE", "The curator response body is missing.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", completed: T | undefined;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const frame = (raw: string) => {
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (event.type === "response.output_text.delta" && typeof event.delta === "string")
      onText(event.delta);
    if (event.type === "response.completed") completed = event.response as T;
    if (["response.failed", "response.incomplete", "error"].includes(event.type))
      throw new AppError("INCOMPLETE", "The curator did not finish its programme.");
  };
  try {
    while (completed === undefined) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (next.done) { if (buffer.trim()) frame(buffer); break; }
    }
    if (completed === undefined)
      throw new AppError("INCOMPLETE", "The curator stream ended before completion.");
    return completed;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
