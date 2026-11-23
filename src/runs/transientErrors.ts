const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_STATUSES = new Set([
  408, 425, 429, 500, 502, 503, 504, 522, 524,
]);

function readCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function readStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { status?: unknown; statusCode?: unknown };
  for (const candidate of [record.status, record.statusCode]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readCause(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as { cause?: unknown }).cause;
}

/**
 * Walks the `cause` chain, because `fetch` failures arrive as
 * `TypeError: fetch failed` wrapping the real `ECONNRESET`, and only the inner
 * error carries the code.
 */
export function isTransientError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);

    const code = readCode(current);
    if (code !== undefined && TRANSIENT_CODES.has(code)) return true;

    const status = readStatus(current);
    if (status !== undefined && TRANSIENT_STATUSES.has(status)) return true;

    if (
      current instanceof Error &&
      /fetch failed|socket hang up|network error|timed? ?out/i.test(
        current.message,
      )
    ) {
      return true;
    }

    current = readCause(current);
  }

  return false;
}
