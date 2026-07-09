/**
 * Returns the input capped at `maxLength` characters.
 *
 * Values longer than the cap are cut and suffixed with an ellipsis so stored
 * blobs (selectors, HTML snippets) cannot grow unbounded in SQLite.
 *
 * @param value Input string, may be undefined/null.
 * @param maxLength Maximum allowed length including the ellipsis suffix.
 * @returns The capped string, or the input when it is short enough or absent.
 */
export function truncate(
  value: string | undefined | null,
  maxLength: number,
): string | undefined {
  if (value == null) return undefined;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
