import { useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VirtualTable } from "../csv/VirtualTable";
import { SheetTabs } from "./SheetTabs";
import { getCellStyleByType } from "./CellFormatter";
import { useXlsxStore } from "../../stores/xlsxStore";
import type { XlsxInfo, XlsxSheetData, XlsxCell } from "../../types";

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

export function XlsxViewer({ tabId, filePath }: XlsxViewerProps) {
  const store = useXlsxStore();
  const tab = useXlsxStore((s) => s.tabs[tabId]);

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

  const sortedRows = useMemo((): XlsxCell[][] => {
    if (!tab?.sheetData) return [];
    const freezeRowCount = tab.sheetData.freeze_pane.rows;
    const dataRows = tab.sheetData.rows.slice(freezeRowCount);
    if (!tab.sort) return dataRows;
    const { columnIndex, direction } = tab.sort;
    return [...dataRows].sort((a, b) => {
      const av = a[columnIndex]?.value ?? "";
      const bv = b[columnIndex]?.value ?? "";
      const cmp = av.localeCompare(bv, undefined, { numeric: true });
      return direction === "asc" ? cmp : -cmp;
    });
  }, [tab?.sheetData, tab?.sort]);

  const frozenDisplayRows = useMemo((): string[][] => {
    if (!tab?.sheetData) return [];
    return tab.sheetData.rows
      .slice(0, tab.sheetData.freeze_pane.rows)
      .map((r) => r.map((c) => c.value));
  }, [tab?.sheetData]);

  const displayRows = useMemo((): string[][] => {
    return sortedRows.map((r) => r.map((c) => c.value));
  }, [sortedRows]);

  const headers = useMemo((): string[] => {
    const cols = tab?.sheetData?.total_cols ?? 0;
    return Array.from({ length: cols }, (_, i) => colLetter(i));
  }, [tab?.sheetData?.total_cols]);

  const getCellStyle = useCallback(
    (rowIdx: number, colIdx: number): React.CSSProperties => {
      const cell = sortedRows[rowIdx]?.[colIdx];
      if (!cell) return {};
      return getCellStyleByType(cell.cell_type);
    },
    [sortedRows]
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
      />
      <SheetTabs
        sheets={tab.info?.sheets ?? []}
        activeSheetName={tab.activeSheetName}
        onSheetSelect={handleSheetSelect}
      />
    </div>
  );
}
