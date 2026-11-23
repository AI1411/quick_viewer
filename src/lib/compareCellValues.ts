/**
 * Parse a string as a number only when the entire string is numeric.
 * Rejects partial parses like parseFloat("2024-03-01") → 2024.
 */
export function tryParseEntireNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Shared cell-value comparator for CSV / XLSX column sorting.
 * Numeric only when both sides parse entirely as numbers; otherwise locale string compare.
 */
export function compareCellValues(a: string, b: string): number {
  const numA = tryParseEntireNumber(a);
  const numB = tryParseEntireNumber(b);
  if (numA !== null && numB !== null) {
    return numA - numB;
  }
  return a.localeCompare(b);
}
