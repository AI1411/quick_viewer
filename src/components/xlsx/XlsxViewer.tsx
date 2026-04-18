import React, { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { VirtualTable } from "../csv/VirtualTable";
import { FilterPopover } from "../csv/FilterPopover";
import { ActiveFiltersBar } from "../csv/ActiveFiltersBar";
import { SheetTabs } from "./SheetTabs";
import { getCellStyleByType } from "./CellFormatter";
import { useXlsxStore } from "../../stores/xlsxStore";
import { useSearchStore } from "../../stores/searchStore";
import { showError } from "../../stores/toastStore";
import { buildRegex } from "../../lib/searchHighlight";
import type { CellMatch } from "../../stores/searchStore";
import type { XlsxInfo, XlsxSheetData, XlsxCell, FilterCondition } from "../../types";

interface XlsxViewerProps {
  tabId: string;
  filePath: string;
}

function colLetter(index: number): string {
  let result = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function matchesFilter(value: string, cond: FilterCondition): boolean {
  switch (cond.filter_type) {
    case "exact": return value === cond.value;
    case "contains": return value.includes(cond.value);
    case "starts_with": return value.startsWith(cond.value);
    case "regex": try { return new RegExp(cond.value).test(value); } catch { return false; }
    case "gt": return parseFloat(value) > parseFloat(cond.value);
    case "lt": return parseFloat(value) < parseFloat(cond.value);
    case "gte": return parseFloat(value) >= parseFloat(cond.value);
    case "lte": return parseFloat(value) <= parseFloat(cond.value);
    case "eq_num": return Math.abs(parseFloat(value) - parseFloat(cond.value)) < Number.EPSILON;
    default: return false;
  }
}

export function XlsxViewer({ tabId, filePath }: XlsxViewerProps) {
  const store = useXlsxStore();
  const tab = useXlsxStore((s) => s.tabs[tabId]);
  const [filterPopover, setFilterPopover] = useState<{
    column: string;
    anchorRect: DOMRect;
  } | null>(null);

  useEffect(() => {
    store.initTab(tabId);
  }, [tabId]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    store.setLoading(tabId, true);
    invoke<XlsxInfo>("read_xlsx", { path: filePath })
      .then((info) => {
        if (cancelled) return;
        store.setInfo(tabId, info);
        const firstSheet = info.sheets[0];
        if (firstSheet) {
          return invoke<XlsxSheetData>("read_xlsx_sheet", {
            path: filePath,
            sheetName: firstSheet.name,
          }).then((data) => {
            if (!cancelled) store.setSheetData(tabId, data, firstSheet.name);
          });
        }
      })
      .catch((e) => { if (!cancelled) store.setError(tabId, String(e)); });
    return () => { cancelled = true; };
  }, [tabId, filePath]);

  // アンマウント時にストア状態をクリーンアップ
  useEffect(() => {
    return () => {
      store.removeTab(tabId);
    };
  }, [tabId, store]);

  const sheetRequestSeqRef = useRef(0);

  const handleSheetSelect = useCallback(
    (sheetName: string) => {
      if (sheetName === tab?.activeSheetName) return;
      store.setLoading(tabId, true);
      const seq = ++sheetRequestSeqRef.current;
      invoke<XlsxSheetData>("read_xlsx_sheet", { path: filePath, sheetName })
        .then((data) => {
          if (seq !== sheetRequestSeqRef.current) return;
          store.setSheetData(tabId, data, sheetName);
        })
        .catch((e) => {
          if (seq !== sheetRequestSeqRef.current) return;
          store.setError(tabId, String(e));
        });
    },
    [tabId, filePath, tab?.activeSheetName]
  );

  const headers = useMemo((): string[] => {
    const cols = tab?.sheetData?.total_cols ?? 0;
    return Array.from({ length: cols }, (_, i) => colLetter(i));
  }, [tab?.sheetData?.total_cols]);

  const filters = tab?.filters ?? [];

  const filteredSortedRows = useMemo((): XlsxCell[][] => {
    if (!tab?.sheetData) return [];
    const freezeRowCount = tab.sheetData.freeze_pane.rows;
    let rows = tab.sheetData.rows.slice(freezeRowCount);

    if (filters.length > 0) {
      rows = rows.filter((row) =>
        filters.every((cond) => {
          const colIdx = headers.indexOf(cond.column);
          if (colIdx === -1) return false;
          return matchesFilter(row[colIdx]?.value ?? "", cond);
        })
      );
    }

    if (!tab.sort) return rows;
    const { columnIndex, direction } = tab.sort;
    return [...rows].sort((a, b) => {
      const av = a[columnIndex]?.value ?? "";
      const bv = b[columnIndex]?.value ?? "";
      const cmp = av.localeCompare(bv, undefined, { numeric: true });
      return direction === "asc" ? cmp : -cmp;
    });
  }, [tab?.sheetData, tab?.sort, filters, headers]);

  const frozenDisplayRows = useMemo((): string[][] => {
    if (!tab?.sheetData) return [];
    return tab.sheetData.rows
      .slice(0, tab.sheetData.freeze_pane.rows)
      .map((r) => r.map((c) => c.value));
  }, [tab?.sheetData]);

  const displayRows = useMemo((): string[][] => {
    return filteredSortedRows.map((r) => r.map((c) => c.value));
  }, [filteredSortedRows]);

  const getCellStyle = useCallback(
    (rowIdx: number, colIdx: number): React.CSSProperties => {
      const cell = filteredSortedRows[rowIdx]?.[colIdx];
      if (!cell) return {};
      return getCellStyleByType(cell.cell_type);
    },
    [filteredSortedRows]
  );

  // 検索ハイライト
  const searchIsOpen = useSearchStore((s) => s.isOpen);
  const searchQuery = useSearchStore((s) => s.query);
  const searchUseRegex = useSearchStore((s) => s.options.useRegex);
  const searchCaseSensitive = useSearchStore((s) => s.options.caseSensitive);
  const cellMatches = useSearchStore((s) => s.cellMatches);
  const currentMatchIndex = useSearchStore((s) => s.currentMatchIndex);
  const scrollToRowRef = useRef<((index: number) => void) | null>(null);

  useEffect(() => {
    if (!searchIsOpen || !searchQuery) {
      useSearchStore.getState().setCellMatches([]);
      return;
    }
    const regex = buildRegex(searchQuery, { useRegex: searchUseRegex, caseSensitive: searchCaseSensitive });
    if (!regex) {
      useSearchStore.getState().setCellMatches([]);
      return;
    }
    const matches: CellMatch[] = [];
    for (let r = 0; r < displayRows.length; r++) {
      for (let c = 0; c < headers.length; c++) {
        regex.lastIndex = 0;
        if (regex.test(displayRows[r][c] ?? "")) matches.push({ row: r, col: c });
      }
    }
    useSearchStore.getState().setCellMatches(matches);
  }, [searchIsOpen, searchQuery, searchUseRegex, searchCaseSensitive, displayRows, headers]);

  useEffect(() => {
    const matches = useSearchStore.getState().cellMatches;
    if (matches.length === 0 || !scrollToRowRef.current) return;
    const match = matches[currentMatchIndex];
    if (match) scrollToRowRef.current(match.row);
  }, [currentMatchIndex]);

  const searchMatchSet = useMemo(() => {
    const set = new Set<string>();
    for (const m of cellMatches) set.add(`${m.row}:${m.col}`);
    return set;
  }, [cellMatches]);

  const currentSearchMatch = cellMatches[currentMatchIndex] ?? null;

  const getCellStyleComposed = useCallback(
    (rowIdx: number, colIdx: number): React.CSSProperties => {
      const base = getCellStyle(rowIdx, colIdx);
      if (currentSearchMatch?.row === rowIdx && currentSearchMatch?.col === colIdx)
        return { ...base, backgroundColor: "#f59e0b", color: "#000000" };
      if (searchMatchSet.has(`${rowIdx}:${colIdx}`))
        return { ...base, backgroundColor: "rgba(254,240,138,0.4)" };
      return base;
    },
    [getCellStyle, searchMatchSet, currentSearchMatch]
  );

  const handleSort = useCallback(
    (colIndex: number) => {
      const current = tab?.sort;
      if (!current || current.columnIndex !== colIndex) {
        store.setSort(tabId, { columnIndex: colIndex, direction: "asc" });
      } else if (current.direction === "asc") {
        store.setSort(tabId, { columnIndex: colIndex, direction: "desc" });
      } else {
        store.setSort(tabId, null);
      }
    },
    [tabId, tab?.sort]
  );

  const handleColumnResize = useCallback(
    (colIndex: number, width: number) => {
      store.setColumnWidth(tabId, colIndex, width);
    },
    [tabId]
  );

  const handleCellClick = useCallback(
    (row: number, col: number, shift: boolean) => {
      if (shift && tab?.selectedAnchor) {
        store.setSelection(tabId, tab.selectedAnchor, { row, col });
      } else {
        store.setSelection(tabId, { row, col }, null);
      }
    },
    [tabId, tab?.selectedAnchor]
  );

  const handleFilterClick = useCallback(
    (colIndex: number, anchorRect: DOMRect) => {
      setFilterPopover({ column: headers[colIndex], anchorRect });
    },
    [headers]
  );

  const handleFilterApply = useCallback(
    (cond: FilterCondition) => {
      const newFilters = [
        ...(tab?.filters ?? []).filter((f) => f.column !== cond.column),
        cond,
      ];
      store.setFilters(tabId, newFilters);
      setFilterPopover(null);
    },
    [tabId, tab?.filters]
  );

  const handleFilterClear = useCallback(
    (column: string) => {
      store.setFilters(tabId, (tab?.filters ?? []).filter((f) => f.column !== column));
      setFilterPopover(null);
    },
    [tabId, tab?.filters]
  );

  const handleClearAllFilters = useCallback(() => {
    store.clearFilters(tabId);
  }, [tabId]);

  const handleExport = useCallback(async () => {
    const outputPath = await save({
      filters: [{ name: "CSV", extensions: ["csv"] }],
      defaultPath: "export.csv",
    });
    if (!outputPath) return;
    try {
      await invoke("export_xlsx_sheet_as_csv", {
        path: filePath,
        sheetName: tab?.activeSheetName ?? "",
        outputPath,
        conditions: filters,
      });
    } catch (err) {
      showError(`XLSX エクスポートに失敗しました: ${String(err)}`);
    }
  }, [filePath, tab?.activeSheetName, filters]);

  if (!tab) return null;

  if (tab.isLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "var(--text-secondary)", backgroundColor: "var(--viewer-bg)" }}
      >
        読み込み中...
      </div>
    );
  }

  if (tab.error) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "#ef4444", backgroundColor: "var(--viewer-bg)" }}
      >
        エラー: {tab.error}
      </div>
    );
  }

  if (!tab.sheetData) return null;

  const freezeCols = tab.sheetData.freeze_pane.cols;
  const freezeRowCount = tab.sheetData.freeze_pane.rows;

  return (
    <div
      className="flex flex-col flex-1 overflow-hidden"
      style={{ backgroundColor: "var(--viewer-bg)" }}
    >
      <ActiveFiltersBar
        filters={filters}
        filePath={filePath}
        onClearFilter={handleFilterClear}
        onClearAll={handleClearAllFilters}
        onExport={handleExport}
      />
      {tab.sheetData.rows.length < tab.sheetData.total_rows && (
        <div
          className="px-3 py-1 text-xs shrink-0"
          style={{ color: "var(--text-secondary)", backgroundColor: "var(--toolbar-bg)", borderBottom: "1px solid var(--border-color)" }}
        >
          先頭 {tab.sheetData.rows.length.toLocaleString()} 行を表示（全 {tab.sheetData.total_rows.toLocaleString()} 行）
        </div>
      )}
      <VirtualTable
        headers={headers}
        rows={displayRows}
        totalRows={displayRows.length}
        columnWidths={tab.columnWidths}
        sort={
          tab.sort
            ? { columnIndex: tab.sort.columnIndex, direction: tab.sort.direction }
            : null
        }
        pinnedCount={freezeCols}
        selectedAnchor={tab.selectedAnchor}
        selectedFocus={tab.selectedFocus}
        onSort={handleSort}
        onColumnResize={handleColumnResize}
        onCellClick={handleCellClick}
        frozenRows={frozenDisplayRows}
        frozenRowCount={freezeRowCount}
        getCellStyle={getCellStyleComposed}
        scrollToRowRef={scrollToRowRef}
        filters={filters}
        onFilterClick={handleFilterClick}
      />
      {filterPopover && (
        <FilterPopover
          column={filterPopover.column}
          anchorRect={filterPopover.anchorRect}
          existing={filters.find((f) => f.column === filterPopover.column) ?? null}
          onApply={handleFilterApply}
          onClear={() => handleFilterClear(filterPopover.column)}
          onClose={() => setFilterPopover(null)}
        />
      )}
      <SheetTabs
        sheets={tab.info?.sheets ?? []}
        activeSheetName={tab.activeSheetName}
        onSheetSelect={handleSheetSelect}
      />
    </div>
  );
}
