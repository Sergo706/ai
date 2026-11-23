
export function safeUrlProtocol(value: string): string {
  try {
    return new URL(value).protocol;
  } catch {
    return "";
  }
}

/** True for absolute http(s) URLs; false for anything the `URL` parser rejects. */
export function isHttpUrl(value: string): boolean {
  return HTTP_PROTOCOLS.has(safeUrlProtocol(value));
}

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
