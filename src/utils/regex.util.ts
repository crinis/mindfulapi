/**
 * Compiles regex strings and throws a descriptive error for invalid patterns.
 *
 * @param patterns Regex source strings to compile.
 * @param fieldName Input field name used in validation error messages.
 * @returns Compiled regular expression instances.
 * @throws Error When any pattern cannot be compiled as a valid regular expression.
 */
export function compileRegexPatterns(
  patterns: string[],
  fieldName: string,
): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern);
    } catch {
      throw new Error(`Invalid regex pattern in ${fieldName}: ${pattern}`);
    }
  });
}
