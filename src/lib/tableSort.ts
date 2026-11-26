/**
 * セルの文字列を数値として読む。"1,234" "-5" "3.5%" "¥1,200" "1e3" に対応し、
 * 数値でなければ null。parseFloat("1,234") が 1 になるのを避ける。
 */
export function parseNumericCell(value: string): number | null {
  const s = value.trim().replace(/^[¥$€£]/, "").replace(/,/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(s)) return null;
  const n = Number(s.replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 並べ替え用の比較。数値同士は数値で、数値と文字列は数値を先に、
 * 文字列同士は辞書順で比べる (どの組み合わせでも順序が矛盾しない)。
 */
export function compareCells(a: string, b: string): number {
  const na = parseNumericCell(a);
  const nb = parseNumericCell(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a.localeCompare(b, "ja");
}

/** 空セルは昇順・降順どちらでも末尾に置く。direction が null なら元の順のまま */
export function sortByColumn<T>(
  rows: T[],
  getValue: (row: T) => string,
  direction: "asc" | "desc" | null
): T[] {
  if (direction === null) return rows;
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((ra, rb) => {
    const a = getValue(ra);
    const b = getValue(rb);
    if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
    return sign * compareCells(a, b);
  });
}
