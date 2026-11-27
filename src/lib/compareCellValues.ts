/**
 * セルの文字列を数値として読む。"1,234" "¥1,200" "12%" "1e3" に対応し、数値でなければ null。
 * parseFloat("2024-03-01") が 2024 に、parseFloat("1,234") が 1 になるような部分一致は数値にしない。
 *
 * Rust 側の try_parse_entire_number と同じ規則 (src-tauri/tests/fixtures/sort-cases.json で両方を検査する)。
 */
export function tryParseEntireNumber(value: string): number | null {
  const s = value.trim().replace(/^[¥$€£]/, "").replace(/,/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(s)) return null;
  const n = Number(s.replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 文字列の並び順は日本語の照合順序に固定する。ロケールを省くと OS の言語で順序が変わり、
 * CSV を並べ替える Rust 側 (こちらも日本語の照合順序) とずれる。
 */
const textOrder = new Intl.Collator("ja");

/**
 * Shared cell-value comparator for CSV / XLSX column sorting.
 * Numbers sort numerically and come before text; text sorts in Japanese collation order.
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
  return textOrder.compare(a, b);
}

/** 列の並べ替え用。空のセルは昇順でも降順でも末尾に置く (Rust 側の compare_rows と同じ) */
export function compareForSort(a: string, b: string, direction: "asc" | "desc"): number {
  if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
  const cmp = compareCellValues(a, b);
  return direction === "asc" ? cmp : -cmp;
}
