/** Replacement for a URL path that must not appear in logs or errors. */
const REDACTED_PATH = '/<redacted>';

/**
 * The path of a URL, as written and as URL parsing normalizes it, unless it
 * is the root path (nothing to hide).
 */
function pathsOf(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const raw = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*(\/[^?#]*)/i.exec(url)?.[1];
  return [...new Set([parsed.pathname, raw])].filter(
    (path): path is string => path !== undefined && path !== '/' && path !== '',
  );
}

/**
 * Replaces every occurrence of `url`'s path in `text` with `/<redacted>`.
 *
 * The Playwright run-server's endpoint path is its only access check (see
 * docker-compose.yml), so it must not reach logs, error messages or BullMQ's
 * stored `failedReason`. Pass the URL itself as `text` to log it, or an error
 * message: Playwright's connect errors repeat the endpoint in their call log
 * (with the query string removed, the path kept).
 */
export function redactUrlPath(text: string, url: string): string {
  return pathsOf(url).reduce(
    (redacted, path) => redacted.split(path).join(REDACTED_PATH),
    text,
  );
}
