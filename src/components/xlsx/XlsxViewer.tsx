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
import { compareForSort } from "../../lib/compareCellValues";
import type { CellMatch } from "../../stores/searchStore";
import type { XlsxInfo, XlsxSheetData, XlsxCell, FilterCondition, ScrollPosition } from "../../types";

function xlsxSortKey(cell: XlsxCell | undefined): string {
  if (!cell) return "";
  if (cell.cell_type === "number" || cell.cell_type === "integer") {
    return cell.raw;
  }
  return cell.value;
}

interface XlsxViewerProps {
  tabId: string;
  filePath: string;
  isActive?: boolean;
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

export function XlsxViewer({ tabId, filePath, isActive = true }: XlsxViewerProps) {
  const tab = useXlsxStore((s) => s.tabs[tabId]);
  const [filterPopover, setFilterPopover] = useState<{
    column: string;
    columnIndex: number;
    anchorRect: DOMRect;
  } | null>(null);

  useEffect(() => {
    const { initTab, setLoading, setInfo, setSheetData, setError } = useXlsxStore.getState();
    initTab(tabId);
    if (!filePath) return;
    let cancelled = false;
    setLoading(tabId, true);
    invoke<XlsxInfo>("read_xlsx", { path: filePath })
      .then((info) => {
        if (cancelled) return;
        setInfo(tabId, info);
        // 再読み込みでは、表示していたシートがまだあればそれを開き直す
        const keptName = useXlsxStore.getState().tabs[tabId]?.activeSheetName;
        const sheet = info.sheets.find((s) => s.name === keptName) ?? info.sheets[0];
        if (sheet) {
          return invoke<XlsxSheetData>("read_xlsx_sheet", {
            path: filePath,
            sheetName: sheet.name,
          }).then((data) => {
            if (!cancelled) setSheetData(tabId, data, sheet.name);
          });
        }
      })
      .catch((e) => { if (!cancelled) setError(tabId, String(e)); });
    return () => { cancelled = true; };
  }, [tabId, filePath]);

  const keepScroll = useCallback(
    (position: ScrollPosition) => useXlsxStore.getState().keepScroll(tabId, position),
    [tabId]
  );

  const sheetRequestSeqRef = useRef(0);

  const handleSheetSelect = useCallback(
    (sheetName: string) => {
      // 読み込みに失敗した後は、同じシートを選び直して再試行できるようにする
      if (sheetName === tab?.activeSheetName && !tab?.error) return;
      const { setLoading, setSheetData, setError } = useXlsxStore.getState();
      setLoading(tabId, true);
      const seq = ++sheetRequestSeqRef.current;
      invoke<XlsxSheetData>("read_xlsx_sheet", { path: filePath, sheetName })
        .then((data) => {
          if (seq !== sheetRequestSeqRef.current) return;
          setSheetData(tabId, data, sheetName);
        })
        .catch((e) => {
          if (seq !== sheetRequestSeqRef.current) return;
          setError(tabId, String(e));
        });
    },
    [tabId, filePath, tab?.activeSheetName, tab?.error]
  );

  const headers = useMemo((): string[] => {
    const cols = tab?.sheetData?.loaded_cols ?? tab?.sheetData?.total_cols ?? 0;
    return Array.from({ length: cols }, (_, i) => colLetter(i));
  }, [tab?.sheetData?.loaded_cols, tab?.sheetData?.total_cols]);

  const filters = useMemo(() => tab?.filters ?? [], [tab?.filters]);

  // 固定行より下の行を絞り込み・並べ替えし、各行の元の行番号も一緒に運ぶ
  const { filteredSortedRows, rowNumbers } = useMemo(() => {
    if (!tab?.sheetData) return { filteredSortedRows: [] as XlsxCell[][], rowNumbers: [] as number[] };
    const freezeRowCount = tab.sheetData.freeze_pane.rows;
    let rows = tab.sheetData.rows
      .slice(freezeRowCount)
      .map((cells, i) => ({ cells, rowNumber: freezeRowCount + i + 1 }));

    if (filters.length > 0) {
      rows = rows.filter(({ cells }) =>
        filters.every((cond) => {
          const colIdx = headers.indexOf(cond.column);
          if (colIdx === -1) return false;
          return matchesFilter(cells[colIdx]?.value ?? "", cond);
        })
      );
    }

    if (tab.sort) {
      const { columnIndex, direction } = tab.sort;
      const order = direction === "asc" ? "asc" : "desc";
      rows.sort((a, b) =>
        compareForSort(xlsxSortKey(a.cells[columnIndex]), xlsxSortKey(b.cells[columnIndex]), order)
      );
    }
    return {
      filteredSortedRows: rows.map((r) => r.cells),
      rowNumbers: rows.map((r) => r.rowNumber),
    };
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
    if (!isActive) return;
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
  }, [isActive, searchIsOpen, searchQuery, searchUseRegex, searchCaseSensitive, displayRows, headers]);

  useEffect(() => {
    if (!isActive) return;
    const matches = useSearchStore.getState().cellMatches;
    if (matches.length === 0 || !scrollToRowRef.current) return;
    const match = matches[currentMatchIndex];
    if (match) scrollToRowRef.current(match.row);
  }, [isActive, currentMatchIndex]);

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
      const { setSort } = useXlsxStore.getState();
      const current = tab?.sort;
      if (!current || current.columnIndex !== colIndex) {
        setSort(tabId, { columnIndex: colIndex, direction: "asc" });
      } else if (current.direction === "asc") {
        setSort(tabId, { columnIndex: colIndex, direction: "desc" });
      } else {
        setSort(tabId, null);
      }
    },
    [tabId, tab?.sort]
  );

  const handleColumnResize = useCallback(
    (colIndex: number, width: number) => {
      useXlsxStore.getState().setColumnWidth(tabId, colIndex, width);
    },
    [tabId]
  );

  const handleCellClick = useCallback(
    (row: number, col: number, shift: boolean) => {
      const { setSelection } = useXlsxStore.getState();
      if (shift && tab?.selectedAnchor) {
        setSelection(tabId, tab.selectedAnchor, { row, col });
      } else {
        setSelection(tabId, { row, col }, null);
      }
    },
    [tabId, tab?.selectedAnchor]
  );

  const handleFilterClick = useCallback(
    (colIndex: number, anchorRect: DOMRect) => {
      setFilterPopover({ column: headers[colIndex], columnIndex: colIndex, anchorRect });
    },
    [headers]
  );

  const handleFilterApply = useCallback(
    (cond: FilterCondition) => {
      const newFilters = [
        ...(tab?.filters ?? []).filter((f) => f.column !== cond.column),
        cond,
      ];
      useXlsxStore.getState().setFilters(tabId, newFilters);
      setFilterPopover(null);
    },
    [tabId, tab?.filters]
  );

  const handleFilterClear = useCallback(
    (target: FilterCondition) => {
      useXlsxStore.getState().setFilters(
        tabId,
        (tab?.filters ?? []).filter((f) => f !== target)
      );
      setFilterPopover(null);
    },
    [tabId, tab?.filters]
  );

  const handleClearAllFilters = useCallback(() => {
    useXlsxStore.getState().clearFilters(tabId);
  }, [tabId]);

  const handleExport = useCallback(async () => {
    try {
      const outputPath = await save({
        filters: [{ name: "CSV", extensions: ["csv"] }],
        defaultPath: "export.csv",
      });
      if (!outputPath) return;
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
    // シートの読み込みだけ失敗した場合も、シートタブから別のシートへ移れるようにする
    return (
      <div
        className="flex flex-col flex-1 overflow-hidden"
        style={{ backgroundColor: "var(--viewer-bg)" }}
      >
        <div
          className="flex-1 flex items-center justify-center text-sm"
          style={{ color: "#ef4444" }}
        >
          エラー: {tab.error}
        </div>
        <SheetTabs
          sheets={tab.info?.sheets ?? []}
          activeSheetName={tab.activeSheetName}
          onSheetSelect={handleSheetSelect}
        />
      </div>
    );
  }

  if (!tab.sheetData) return null;

  const freezeCols = tab.sheetData.freeze_pane.cols;
  const freezeRowCount = tab.sheetData.freeze_pane.rows;
  const loadedRows = tab.sheetData.rows.length;
  const loadedCols = tab.sheetData.loaded_cols ?? tab.sheetData.total_cols;
  const popoverFilter = filterPopover
    ? (filters.find((f) => f.column === filterPopover.column) ?? null)
    : null;

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
      {(loadedRows < tab.sheetData.total_rows || loadedCols < tab.sheetData.total_cols) && (
        <div
          className="px-3 py-1 text-xs shrink-0"
          style={{ color: "var(--text-secondary)", backgroundColor: "var(--toolbar-bg)", borderBottom: "1px solid var(--border-color)" }}
        >
          先頭 {loadedRows.toLocaleString()} 行 × {loadedCols.toLocaleString()} 列を表示（全{" "}
          {tab.sheetData.total_rows.toLocaleString()} 行 × {tab.sheetData.total_cols.toLocaleString()} 列）
        </div>
      )}
      <VirtualTable
        headers={headers}
        rows={displayRows}
        rowNumbers={rowNumbers}
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
        initialScroll={tab.scroll}
        onScrollKeep={keepScroll}
      />
      {filterPopover && (
        <FilterPopover
          column={filterPopover.column}
          columnIndex={filterPopover.columnIndex}
          anchorRect={filterPopover.anchorRect}
          existing={popoverFilter}
          onApply={handleFilterApply}
          onClear={() => {
            if (popoverFilter) handleFilterClear(popoverFilter);
          }}
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
