import { useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCsvStore } from "../../stores/csvStore";
import { VirtualTable } from "./VirtualTable";
import type { CsvData, CsvChunk } from "../../types";

const CHUNK_SIZE = 200;
const INITIAL_LIMIT = 100;

interface CsvViewerProps {
  tabId: string;
  filePath: string;
}

export function CsvViewer({ tabId, filePath }: CsvViewerProps) {
  const tabState = useCsvStore((s) => s.tabs[tabId]);

  // 初期化 & データ読み込み
  useEffect(() => {
    const { initTab, setLoading, setData, setError } = useCsvStore.getState();
    initTab(tabId);
    setLoading(tabId, true);
    invoke<CsvData>("read_csv", { path: filePath, limit: INITIAL_LIMIT })
      .then((data) => setData(tabId, data))
      .catch((err) => setError(tabId, String(err)));
  }, [tabId, filePath]);

  // チャンク追加読み込み
  const handleScrollEnd = useCallback(() => {
    const tab = useCsvStore.getState().tabs[tabId];
    if (!tab || tab.isLoadingChunk || !tab.data) return;
    if (tab.loadedRows >= tab.data.meta.total_rows) return;

    const { setLoadingChunk, appendRows } = useCsvStore.getState();
    setLoadingChunk(tabId, true);
    invoke<CsvChunk>("read_csv_chunk", {
      path: filePath,
      offset: tab.loadedRows,
      limit: CHUNK_SIZE,
    })
      .then((chunk) => appendRows(tabId, chunk.rows, chunk.total_rows))
      .catch(() => setLoadingChunk(tabId, false));
  }, [tabId, filePath]);

  // ソート切り替え
  const handleSort = useCallback(
    (colIndex: number) => {
      const { setSort } = useCsvStore.getState();
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab) return;
      const current = tab.sort;
      if (!current || current.columnIndex !== colIndex) {
        setSort(tabId, { columnIndex: colIndex, direction: "asc" });
      } else if (current.direction === "asc") {
        setSort(tabId, { columnIndex: colIndex, direction: "desc" });
      } else {
        setSort(tabId, null);
      }
    },
    [tabId]
  );

  // セル選択（shift クリックで範囲選択）
  const handleCellClick = useCallback(
    (row: number, col: number, shift: boolean) => {
      const { setSelection } = useCsvStore.getState();
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab) return;
      if (shift && tab.selectedAnchor) {
        setSelection(tabId, tab.selectedAnchor, { row, col });
      } else {
        setSelection(tabId, { row, col }, { row, col });
      }
    },
    [tabId]
  );

  // ピン留め切り替え（右クリックで列ヘッダ → ci 以前をピン / ci をピン解除）
  const handlePinToggle = useCallback(
    (colIndex: number) => {
      const { setPinnedCount } = useCsvStore.getState();
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab) return;
      const newCount =
        colIndex < tab.pinnedCount ? colIndex : colIndex + 1;
      setPinnedCount(tabId, newCount);
    },
    [tabId]
  );

  // ソート済み行（クライアントサイドソート）
  const sortedRows = useMemo(() => {
    if (!tabState?.data) return [];
    const { rows } = tabState.data;
    const sort = tabState.sort;
    if (!sort) return rows;
    const { columnIndex, direction } = sort;
    return [...rows].sort((a, b) => {
      const va = a[columnIndex] ?? "";
      const vb = b[columnIndex] ?? "";
      const numA = parseFloat(va);
      const numB = parseFloat(vb);
      const isNumeric = !isNaN(numA) && !isNaN(numB);
      const cmp = isNumeric ? numA - numB : va.localeCompare(vb);
      return direction === "asc" ? cmp : -cmp;
    });
  }, [tabState?.data, tabState?.sort]);

  if (!tabState) return null;

  if (tabState.isLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "var(--text-secondary)" }}
      >
        読み込み中...
      </div>
    );
  }

  if (tabState.error) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "#f87171" }}
      >
        エラー: {tabState.error}
      </div>
    );
  }

  if (!tabState.data) return null;

  const { headers, meta } = tabState.data;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <VirtualTable
        headers={headers}
        rows={sortedRows}
        totalRows={meta.total_rows}
        columnWidths={tabState.columnWidths}
        sort={tabState.sort}
        pinnedCount={tabState.pinnedCount}
        selectedAnchor={tabState.selectedAnchor}
        selectedFocus={tabState.selectedFocus}
        onSort={handleSort}
        onColumnResize={(ci, w) =>
          useCsvStore.getState().setColumnWidth(tabId, ci, w)
        }
        onPinToggle={handlePinToggle}
        onCellClick={handleCellClick}
        onScrollEnd={handleScrollEnd}
      />
      {/* ステータスバー（Phase 2.4 で拡張予定） */}
      <div
        className="flex items-center gap-4 px-3 text-xs border-t flex-shrink-0"
        style={{
          height: 24,
          borderColor: "var(--border-color)",
          color: "var(--text-secondary)",
          backgroundColor: "var(--tabbar-bg)",
        }}
      >
        <span>{meta.total_rows.toLocaleString()} 行</span>
        <span>{headers.length} 列</span>
        <span>{meta.encoding}</span>
        <span>区切り: {meta.delimiter === "\t" ? "TAB" : meta.delimiter}</span>
        {tabState.loadedRows < meta.total_rows && (
          <span style={{ color: "#fbbf24" }}>
            ({tabState.loadedRows.toLocaleString()} 行読み込み済み)
          </span>
        )}
      </div>
    </div>
  );
}
