export type DiscoveryProgress = {
  stage: "metadata" | "context" | "curating" | "verifying" | "repairing";
  completed?: number;
  total?: number;
};

export class RecommendationRequestError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

/** Reconnect once with the same request ID so the server can reuse the same work. */
export async function requestRecommendations<T>(
  input: unknown,
  signal: AbortSignal,
  onProgress: (progress: DiscoveryProgress) => void,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const body = JSON.stringify(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetcher("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body,
        signal,
      });
      return await readRecommendationResponse<T>(response, onProgress);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const disconnected = error instanceof TypeError ||
        (error instanceof RecommendationRequestError && error.code === "INCOMPLETE");
      if (attempt || !disconnected) throw error;
    }
  }
  throw new RecommendationRequestError("INCOMPLETE");
}

/** Consume actual server progress while retaining compatibility with JSON clients. */
export async function readRecommendationResponse<T>(
  response: Response,
  onProgress: (progress: DiscoveryProgress) => void,
): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    let data;
    try { data = await response.json(); }
    catch {
      // Gateways can return HTML instead of the API envelope. Retry only a
      // truncated success or a transient gateway response, never a bad input.
      throw new RecommendationRequestError(response.ok || [502, 503, 504].includes(response.status)
        ? "INCOMPLETE" : "UPSTREAM_ERROR");
    }
    if (!response.ok || data.error)
      throw new RecommendationRequestError(data.error?.code ?? "UPSTREAM_ERROR", data.error?.message);
    return data as T;
  }
  if (!response.body) throw new RecommendationRequestError("INCOMPLETE");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffered = "";
  const consume = (line: string): { value: T } | undefined => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new RecommendationRequestError("INCOMPLETE"); }
    if (event.type === "error")
      throw new RecommendationRequestError(event.error?.code ?? "UPSTREAM_ERROR", event.error?.message);
    if (event.type === "result") return { value: event.data as T };
    if (event.type === "progress" &&
      ["metadata", "context", "curating", "verifying", "repairing"].includes(event.stage)) {
      onProgress({ stage: event.stage,
        ...(Number.isFinite(event.completed) ? { completed: event.completed } : {}),
        ...(Number.isFinite(event.total) ? { total: event.total } : {}),
      });
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const result = consume(line);
        if (result) return result.value;
      }
      if (buffered.length > 2_097_152) throw new RecommendationRequestError("INCOMPLETE");
      if (done) {
        const result = consume(buffered);
        if (result) return result.value;
        throw new RecommendationRequestError("INCOMPLETE");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
