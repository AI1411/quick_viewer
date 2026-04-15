import { useEffect, useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCsvStore } from "../../stores/csvStore";
import { VirtualTable } from "./VirtualTable";
import { FilterPopover } from "./FilterPopover";
import { ActiveFiltersBar } from "./ActiveFiltersBar";
import { StatusBar } from "./StatusBar";
import type { CsvData, CsvChunk, FilterCondition } from "../../types";

const CHUNK_SIZE = 200;
const INITIAL_LIMIT = 100;

interface CsvViewerProps {
  tabId: string;
  filePath: string;
}

export function CsvViewer({ tabId, filePath }: CsvViewerProps) {
  const tabState = useCsvStore((s) => s.tabs[tabId]);

  // フィルタポップオーバーの表示状態
  const [filterColIndex, setFilterColIndex] = useState<number | null>(null);
  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(null);

  // 初期化 & データ読み込み
  useEffect(() => {
    const { initTab, setLoading, setData, setError } = useCsvStore.getState();
    initTab(tabId);
    setLoading(tabId, true);
    invoke<CsvData>("read_csv", { path: filePath, limit: INITIAL_LIMIT })
      .then((data) => setData(tabId, data))
      .catch((err) => setError(tabId, String(err)));
  }, [tabId, filePath]);

  // チャンク追加読み込み（フィルタ中は無効）
  const handleScrollEnd = useCallback(() => {
    const tab = useCsvStore.getState().tabs[tabId];
    if (!tab || tab.isLoadingChunk || !tab.data) return;
    if (tab.filters.length > 0) return; // フィルタ中はチャンク不要
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

  // フィルタアイコンクリック
  const handleFilterClick = useCallback(
    (colIndex: number, anchorRect: DOMRect) => {
      setFilterColIndex(colIndex);
      setFilterAnchorRect(anchorRect);
    },
    []
  );

  // フィルタ適用（Rust filter_csv を呼び出してフィルタ結果を store に保存）
  const handleFilterApply = useCallback(
    async (cond: FilterCondition) => {
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab?.data) return;
      const { setFiltering, setFilters } = useCsvStore.getState();

      const newFilters = tab.filters
        .filter((f) => f.column !== cond.column)
        .concat(cond);

      setFiltering(tabId, true);
      try {
        const data = await invoke<CsvData>("filter_csv", {
          path: filePath,
          conditions: newFilters,
        });
        setFilters(tabId, newFilters, data.rows);
      } catch {
        setFiltering(tabId, false);
      }
    },
    [tabId, filePath]
  );

  // 単一列フィルタのクリア
  const handleFilterClearColumn = useCallback(
    async (column: string) => {
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab) return;
      const { setFiltering, setFilters, clearFilters } = useCsvStore.getState();

      const newFilters = tab.filters.filter((f) => f.column !== column);
      if (newFilters.length === 0) {
        clearFilters(tabId);
        return;
      }

      setFiltering(tabId, true);
      try {
        const data = await invoke<CsvData>("filter_csv", {
          path: filePath,
          conditions: newFilters,
        });
        setFilters(tabId, newFilters, data.rows);
      } catch {
        setFiltering(tabId, false);
      }
    },
    [tabId, filePath]
  );

  // 全フィルタのクリア
  const handleClearAllFilters = useCallback(() => {
    useCsvStore.getState().clearFilters(tabId);
  }, [tabId]);

  // 表示行（フィルタ結果優先 → クライアントサイドソート）
  const displayRows = useMemo(() => {
    if (!tabState?.data) return [];
    const rows = tabState.filteredRows ?? tabState.data.rows;
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
  }, [tabState?.data, tabState?.filteredRows, tabState?.sort]);

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

  // フィルタポップオーバーで表示する既存条件
  const existingFilter =
    filterColIndex !== null
      ? (tabState.filters.find((f) => f.column === headers[filterColIndex]) ?? null)
      : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* アクティブフィルタバー */}
      <ActiveFiltersBar
        filters={tabState.filters}
        filePath={filePath}
        onClearFilter={handleFilterClearColumn}
        onClearAll={handleClearAllFilters}
      />

      {/* フィルタ中インジケータ */}
      {tabState.isFiltering && (
        <div
          className="flex items-center justify-center text-xs py-1 flex-shrink-0"
          style={{ color: "var(--text-secondary)", backgroundColor: "var(--tabbar-bg)" }}
        >
          フィルタ適用中...
        </div>
      )}

      <VirtualTable
        headers={headers}
        rows={displayRows}
        totalRows={meta.total_rows}
        columnWidths={tabState.columnWidths}
        sort={tabState.sort}
        pinnedCount={tabState.pinnedCount}
        selectedAnchor={tabState.selectedAnchor}
        selectedFocus={tabState.selectedFocus}
        filters={tabState.filters}
        onSort={handleSort}
        onColumnResize={(ci, w) =>
          useCsvStore.getState().setColumnWidth(tabId, ci, w)
        }
        onPinToggle={handlePinToggle}
        onCellClick={handleCellClick}
        onScrollEnd={handleScrollEnd}
        onFilterClick={handleFilterClick}
      />

      {/* ステータスバー */}
      <StatusBar
        totalRows={meta.total_rows}
        filteredCount={tabState.filteredRows !== null ? tabState.filteredRows.length : null}
        columns={headers.length}
        encoding={meta.encoding}
        delimiter={meta.delimiter}
        loadedRows={tabState.loadedRows}
        selectedAnchor={tabState.selectedAnchor}
        selectedFocus={tabState.selectedFocus}
        displayRows={displayRows}
      />

      {/* フィルタポップオーバー */}
      {filterColIndex !== null && filterAnchorRect !== null && (
        <FilterPopover
          column={headers[filterColIndex]}
          anchorRect={filterAnchorRect}
          existing={existingFilter}
          onApply={handleFilterApply}
          onClear={() => handleFilterClearColumn(headers[filterColIndex])}
          onClose={() => {
            setFilterColIndex(null);
            setFilterAnchorRect(null);
          }}
        />
      )}
    </div>
  );
}
