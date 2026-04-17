import { useEffect, useMemo, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { VirtualTable } from "../csv/VirtualTable";
import { FilterPopover } from "../csv/FilterPopover";
import { ActiveFiltersBar } from "../csv/ActiveFiltersBar";
import { SheetTabs } from "./SheetTabs";
import { getCellStyleByType } from "./CellFormatter";
import { useXlsxStore } from "../../stores/xlsxStore";
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
    store.setLoading(tabId, true);
    invoke<XlsxInfo>("read_xlsx", { path: filePath })
      .then((info) => {
        store.setInfo(tabId, info);
        const firstSheet = info.sheets[0];
        if (firstSheet) {
          return invoke<XlsxSheetData>("read_xlsx_sheet", {
            path: filePath,
            sheetName: firstSheet.name,
          }).then((data) => store.setSheetData(tabId, data, firstSheet.name));
        }
      })
      .catch((e) => store.setError(tabId, String(e)));
  }, [tabId, filePath]);

  const handleSheetSelect = useCallback(
    (sheetName: string) => {
      if (sheetName === tab?.activeSheetName) return;
      store.setLoading(tabId, true);
      invoke<XlsxSheetData>("read_xlsx_sheet", { path: filePath, sheetName })
        .then((data) => store.setSheetData(tabId, data, sheetName))
        .catch((e) => store.setError(tabId, String(e)));
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
      console.error("Export error:", err);
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
        getCellStyle={getCellStyle}
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
