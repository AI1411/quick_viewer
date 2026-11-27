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
 * Numbers sort numerically and come before text; text uses locale string compare.
 *
 * 数値と文字列を文字列として比べると、2 < 10 < "1x" < 2 のように順序が循環する。
 * Rust 側の compare_cell_values と同じく、数値はすべて文字列より前に置く。
 */
export function compareCellValues(a: string, b: string): number {
  const numA = tryParseEntireNumber(a);
  const numB = tryParseEntireNumber(b);
  if (numA !== null && numB !== null) {
    return numA - numB;
  }
  if (numA !== null) return -1;
  if (numB !== null) return 1;
  return a.localeCompare(b);
}
