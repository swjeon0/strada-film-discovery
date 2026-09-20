export function config() {
  return {
    openai: process.env.OPENAI_API_KEY,
    tmdb: process.env.TMDB_READ_ACCESS_TOKEN,
  };
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}
export function errorResponse(e: unknown) {
  if (!(e instanceof AppError))
    console.error(
      "STRADA server error",
      e instanceof Error ? { name: e.name, message: e.message } : String(e),
    );
  const err =
    e instanceof DOMException && e.name === "TimeoutError"
      ? new AppError(
          "TIMEOUT",
          "Research took too long. Your current trail is safe; please try again.",
          504,
        )
      : e instanceof DOMException && e.name === "AbortError"
        ? new AppError(
            "CANCELED",
            "Research was canceled. Your trail is unchanged.",
            499,
          )
        : e instanceof AppError
          ? e
          : new AppError(
              "UPSTREAM_ERROR",
              "The service could not finish this request. Please try again.",
            );
  return Response.json(
    {
      error: {
        code: err.code,
        message: err.message,
        retryable: err.status !== 400 && err.status !== 503,
      },
    },
    { status: err.status },
  );
}
export function checkOrigin(r: Request) {
  const origin = r.headers.get("origin");
  if (!origin) return;
  // Next can construct an internal localhost URL even for a 127.0.0.1 request.
  // Host is the browser's actual request target; never use X-Forwarded-Host,
  // which can otherwise turn an arbitrary origin into an allowed one.
  const url = new URL(r.url),
    host = r.headers.get("host") || url.host,
    forwardedProtocol = r.headers.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? `${forwardedProtocol}:`
      : url.protocol;
  if (origin !== `${protocol}//${host}`)
    throw new AppError(
      "INVALID_ORIGIN",
      "This request must come from STRADA.",
      403,
    );
}
