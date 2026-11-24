
/**
 * Read a URL's protocol without throwing.
 *
 * @param value - The candidate URL.
 * @returns The protocol such as `"https:"`, or `""` when the URL is invalid.
 */
export function safeUrlProtocol(value: string): string {
  try {
    return new URL(value).protocol;
  } catch {
    return "";
  }
}

/**
 * Whether a string is an absolute `http` or `https` URL.
 *
 * @param value - The candidate URL.
 * @returns `true` for http(s) URLs; `false` for anything else, including
 * relative paths.
 */
export function isHttpUrl(value: string): boolean {
  return HTTP_PROTOCOLS.has(safeUrlProtocol(value));
}

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
