import React, { useRef, useCallback, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SortState, SelectedCell } from "../../stores/csvStore";
import type { FilterCondition } from "../../types";

const ROW_HEIGHT = 28;
const ROW_NUM_WIDTH = 52;
const DEFAULT_COL_WIDTH = 120;
const MIN_COL_WIDTH = 40;

interface VirtualTableProps {
  headers: string[];
  rows: string[][];
  totalRows: number;
  columnWidths: Record<number, number>;
  sort: SortState | null;
  pinnedCount: number;
  selectedAnchor: SelectedCell | null;
  selectedFocus: SelectedCell | null;
  onSort: (colIndex: number) => void;
  onColumnResize: (colIndex: number, width: number) => void;
  onCellClick: (row: number, col: number, shift: boolean) => void;
  onPinToggle?: (colIndex: number) => void;
  onScrollEnd?: () => void;
  filters?: FilterCondition[];
  onFilterClick?: (colIndex: number, anchorRect: DOMRect) => void;
  frozenRows?: string[][];
  frozenRowCount?: number;
  getCellStyle?: (rowIdx: number, colIdx: number) => React.CSSProperties;
}

function isCellSelected(
  row: number,
  col: number,
  anchor: SelectedCell | null,
  focus: SelectedCell | null
): boolean {
  if (!anchor) return false;
  const f = focus ?? anchor;
  const minRow = Math.min(anchor.row, f.row);
  const maxRow = Math.max(anchor.row, f.row);
  const minCol = Math.min(anchor.col, f.col);
  const maxCol = Math.max(anchor.col, f.col);
  return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
}

export function VirtualTable({
  headers,
  rows,
  totalRows,
  columnWidths,
  sort,
  pinnedCount,
  selectedAnchor,
  selectedFocus,
  onSort,
  onColumnResize,
  onCellClick,
  onPinToggle,
  onScrollEnd,
  filters,
  onFilterClick,
  frozenRows,
  frozenRowCount,
  getCellStyle,
}: VirtualTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef<{
    colIndex: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // スクロール末尾でチャンク読み込みトリガー
  useEffect(() => {
    const el = parentRef.current;
    if (!el || !onScrollEnd) return;
    const handler = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 5) {
        if (rows.length < totalRows) onScrollEnd();
      }
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [rows.length, totalRows, onScrollEnd]);

  const getColWidth = useCallback(
    (i: number) => columnWidths[i] ?? DEFAULT_COL_WIDTH,
    [columnWidths]
  );

  // 列リサイズ開始
  const startResize = useCallback(
    (e: React.MouseEvent, colIndex: number) => {
      e.preventDefault();
      e.stopPropagation();
      resizingRef.current = {
        colIndex,
        startX: e.clientX,
        startWidth: getColWidth(colIndex),
      };

      const onMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const { colIndex: ci, startX, startWidth } = resizingRef.current;
        const newWidth = Math.max(MIN_COL_WIDTH, startWidth + ev.clientX - startX);
        onColumnResize(ci, newWidth);
      };
      const onUp = () => {
        resizingRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [getColWidth, onColumnResize]
  );

  const totalColWidth =
    ROW_NUM_WIDTH +
    headers.reduce((sum, _, i) => sum + getColWidth(i), 0);

  const pinnedLeftOf = (i: number) =>
    ROW_NUM_WIDTH +
    headers.slice(0, i).reduce((s, _, j) => s + getColWidth(j), 0);

  const sortIcon = (i: number) => {
    if (!sort || sort.columnIndex !== i) return " ↕";
    return sort.direction === "asc" ? " ↑" : " ↓";
  };

  return (
    <div
      ref={parentRef}
      className="overflow-auto flex-1 relative select-none"
      style={{ backgroundColor: "var(--viewer-bg)", color: "var(--text-primary)" }}
    >
      {/* Sticky header */}
      <div
        className="sticky top-0 z-10 flex border-b"
        style={{
          minWidth: totalColWidth,
          backgroundColor: "var(--tabbar-bg)",
          borderColor: "var(--border-color)",
          height: ROW_HEIGHT,
        }}
      >
        {/* Row number header */}
        <div
          className="flex-shrink-0 flex items-center justify-center text-xs font-medium"
          style={{
            width: ROW_NUM_WIDTH,
            borderRight: "1px solid var(--border-color)",
            color: "var(--text-secondary)",
          }}
        >
          #
        </div>

        {/* Column headers */}
        {headers.map((header, i) => {
          const isPinned = i < pinnedCount;
          const hasFilter = filters?.some((f) => f.column === header) ?? false;
          return (
            <div
              key={i}
              className="relative flex items-center overflow-hidden"
              style={{
                width: getColWidth(i),
                flexShrink: 0,
                borderRight: "1px solid var(--border-color)",
                ...(isPinned
                  ? {
                      position: "sticky",
                      left: pinnedLeftOf(i),
                      backgroundColor: "var(--tabbar-bg)",
                      zIndex: 20,
                    }
                  : {}),
              }}
            >
              <button
                className="flex-1 text-left px-2 text-xs font-medium truncate"
                style={{ color: "var(--text-primary)", height: ROW_HEIGHT }}
                onClick={() => onSort(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onPinToggle?.(i);
                }}
                title={`クリック: ソート | 右クリック: ピン留め切り替え`}
              >
                {isPinned && <span className="mr-1 text-blue-400">📌</span>}
                {header}
                <span style={{ color: "var(--text-secondary)" }}>
                  {sortIcon(i)}
                </span>
              </button>
              {/* Filter button */}
              {onFilterClick && (
                <button
                  className="flex-shrink-0 flex items-center justify-center text-xs"
                  style={{
                    width: 18,
                    height: ROW_HEIGHT,
                    color: hasFilter ? "#3b82f6" : "var(--text-secondary)",
                    opacity: hasFilter ? 1 : 0.4,
                    transition: "opacity 0.1s",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onFilterClick(i, e.currentTarget.getBoundingClientRect());
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.opacity = "1";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.opacity = hasFilter ? "1" : "0.4";
                  }}
                  title="フィルタ"
                >
                  ▽
                </button>
              )}
              {/* Resize handle */}
              <div
                className="absolute right-0 top-0 w-1 h-full cursor-col-resize"
                style={{ opacity: 0.4 }}
                onMouseDown={(e) => startResize(e, i)}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.opacity = "1";
                  (e.currentTarget as HTMLElement).style.backgroundColor =
                    "#3b82f6";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.opacity = "0.4";
                  (e.currentTarget as HTMLElement).style.backgroundColor = "";
                }}
              />
            </div>
          );
        })}
      </div>

      {/* フリーズ行（sticky） */}
      {frozenRows?.map((frozenRow, frozenIdx) => (
        <div
          key={`frozen-${frozenIdx}`}
          className="flex sticky z-[5]"
          style={{
            top: ROW_HEIGHT * (frozenIdx + 1),
            height: ROW_HEIGHT,
            minWidth: totalColWidth,
            borderBottom: "1px solid var(--border-color)",
            backgroundColor: "var(--tabbar-bg)",
          }}
        >
          <div
            className="flex-shrink-0 flex items-center justify-center text-xs"
            style={{
              width: ROW_NUM_WIDTH,
              borderRight: "1px solid var(--border-color)",
              color: "var(--text-secondary)",
            }}
          >
            {frozenIdx + 1}
          </div>
          {headers.map((_, colIdx) => (
            <div
              key={colIdx}
              className="flex items-center px-2 text-xs overflow-hidden"
              style={{
                width: getColWidth(colIdx),
                flexShrink: 0,
                borderRight: "1px solid var(--border-color)",
              }}
            >
              <span className="truncate">{frozenRow[colIdx] ?? ""}</span>
            </div>
          ))}
        </div>
      ))}

      {/* Virtual rows */}
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          minWidth: totalColWidth,
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              className="flex absolute top-0 left-0 w-full"
              style={{
                height: ROW_HEIGHT,
                transform: `translateY(${virtualRow.start}px)`,
                borderBottom: "1px solid var(--border-color)",
              }}
            >
              {/* Row number */}
              <div
                className="flex-shrink-0 flex items-center justify-center text-xs"
                style={{
                  width: ROW_NUM_WIDTH,
                  borderRight: "1px solid var(--border-color)",
                  color: "var(--text-secondary)",
                  backgroundColor: "var(--tabbar-bg)",
                }}
              >
                {virtualRow.index + 1 + (frozenRowCount ?? 0)}
              </div>

              {/* Cells */}
              {headers.map((_, colIdx) => {
                const selected = isCellSelected(
                  virtualRow.index,
                  colIdx,
                  selectedAnchor,
                  selectedFocus
                );
                const isPinned = colIdx < pinnedCount;
                return (
                  <div
                    key={colIdx}
                    className="flex items-center px-2 text-xs overflow-hidden cursor-pointer"
                    style={{
                      width: getColWidth(colIdx),
                      flexShrink: 0,
                      borderRight: "1px solid var(--border-color)",
                      ...(isPinned
                        ? {
                            position: "sticky",
                            left: pinnedLeftOf(colIdx),
                            backgroundColor: selected
                              ? "rgba(59,130,246,0.25)"
                              : "var(--viewer-bg)",
                            zIndex: 5,
                          }
                        : {
                            backgroundColor: selected
                              ? "rgba(59,130,246,0.25)"
                              : undefined,
                          }),
                    }}
                    onClick={(e) =>
                      onCellClick(virtualRow.index, colIdx, e.shiftKey)
                    }
                    title={row?.[colIdx] ?? ""}
                  >
                    <span
                      className="truncate"
                      style={getCellStyle?.(virtualRow.index, colIdx)}
                    >
                      {row?.[colIdx] ?? ""}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
