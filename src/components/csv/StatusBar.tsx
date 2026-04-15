import type { SelectedCell } from "../../stores/csvStore";

interface StatsResult {
  count: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
}

export function computeStats(
  rows: string[][],
  anchor: SelectedCell,
  focus: SelectedCell
): StatsResult {
  const minRow = Math.min(anchor.row, focus.row);
  const maxRow = Math.max(anchor.row, focus.row);
  const minCol = Math.min(anchor.col, focus.col);
  const maxCol = Math.max(anchor.col, focus.col);

  const count = (maxRow - minRow + 1) * (maxCol - minCol + 1);
  const values: number[] = [];

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const v = rows[r]?.[c];
      if (v !== undefined && v !== "") {
        const n = parseFloat(v);
        if (!isNaN(n)) values.push(n);
      }
    }
  }

  if (values.length === 0) {
    return { count, sum: null, avg: null, min: null, max: null };
  }

  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count,
    sum,
    avg: sum / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

interface StatusBarProps {
  totalRows: number;
  filteredCount: number | null;
  columns: number;
  encoding: string;
  delimiter: string;
  loadedRows: number;
  selectedAnchor: SelectedCell | null;
  selectedFocus: SelectedCell | null;
  displayRows: string[][];
}

export function StatusBar({
  totalRows,
  filteredCount,
  columns,
  encoding,
  delimiter,
  loadedRows,
  selectedAnchor,
  selectedFocus,
  displayRows,
}: StatusBarProps) {
  const stats =
    selectedAnchor && selectedFocus
      ? computeStats(displayRows, selectedAnchor, selectedFocus)
      : null;

  const delimLabel = delimiter === "\t" ? "TAB" : delimiter;

  return (
    <div
      className="flex items-center gap-4 px-3 text-xs border-t flex-shrink-0 overflow-x-auto"
      style={{
        height: 24,
        borderColor: "var(--border-color)",
        color: "var(--text-secondary)",
        backgroundColor: "var(--tabbar-bg)",
        whiteSpace: "nowrap",
      }}
    >
      <span>
        {filteredCount !== null
          ? `${filteredCount.toLocaleString()} / ${totalRows.toLocaleString()} 行`
          : `${totalRows.toLocaleString()} 行`}
      </span>
      <span>{columns} 列</span>
      <span>{encoding}</span>
      <span>区切り: {delimLabel}</span>
      {loadedRows < totalRows && filteredCount === null && (
        <span style={{ color: "#fbbf24" }}>
          ({loadedRows.toLocaleString()} 行読み込み済み)
        </span>
      )}
      {stats && (
        <>
          <span style={{ borderLeft: "1px solid var(--border-color)", paddingLeft: "1rem" }}>
            選択: {stats.count.toLocaleString()} セル
          </span>
          {stats.sum !== null && (
            <>
              <span>合計: {stats.sum.toLocaleString()}</span>
              <span>
                平均:{" "}
                {stats.avg?.toLocaleString(undefined, {
                  maximumFractionDigits: 4,
                })}
              </span>
              <span>最小: {stats.min?.toLocaleString()}</span>
              <span>最大: {stats.max?.toLocaleString()}</span>
            </>
          )}
        </>
      )}
    </div>
  );
}
