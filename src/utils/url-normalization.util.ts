/**
 * Returns a normalized absolute HTTP(S) URL string.
 * - Removes fragment identifiers
 * - Drops default ports 80/443
 * - Removes trailing slash except root path
 *
 * @param rawUrl Input URL to normalize.
 * @param baseUrl Optional base URL used for relative URL resolution.
 * @returns Canonical absolute URL string or `null` when input is invalid/non-HTTP(S).
 */
export function normalizeHttpUrl(
  rawUrl: string,
  baseUrl?: string,
): string | null {
  try {
    const normalized = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if (!['http:', 'https:'].includes(normalized.protocol)) return null;

    normalized.hash = '';

    if (
      (normalized.protocol === 'http:' && normalized.port === '80') ||
      (normalized.protocol === 'https:' && normalized.port === '443')
    ) {
      normalized.port = '';
    }

    if (normalized.pathname.length > 1 && normalized.pathname.endsWith('/')) {
      normalized.pathname = normalized.pathname.replace(/\/+$/, '');
    }

    return normalized.toString();
  } catch {
    return null;
  }
}

/**
 * Normalizes a list of URLs and removes invalid and duplicate entries.
 *
 * @param urls Input URL strings.
 * @returns Unique normalized HTTP(S) URLs preserving insertion order.
 */
export function normalizeAndDedupeHttpUrls(urls: string[]): string[] {
  const unique = new Set<string>();

  for (const rawUrl of urls) {
    const normalized = normalizeHttpUrl(rawUrl);
    if (normalized) unique.add(normalized);
  }

  return Array.from(unique);
}
