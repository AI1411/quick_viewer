import { useEffect, useCallback, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sortByColumn } from "../../lib/tableSort";
import { useCsvStore } from "../../stores/csvStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSearchStore } from "../../stores/searchStore";
import { showError, showWarning } from "../../stores/toastStore";
import { buildRegex } from "../../lib/searchHighlight";
import type { CellMatch } from "../../stores/searchStore";
import { VirtualTable } from "./VirtualTable";
import { FilterPopover } from "./FilterPopover";
import { ActiveFiltersBar } from "./ActiveFiltersBar";
import { StatusBar } from "./StatusBar";
import type { CsvData, CsvChunk, FilterCondition } from "../../types";
import type React from "react";

const CHUNK_SIZE = 200;
/** 並べ替え・検索のために全行を読み込む上限 */
const FULL_LOAD_LIMIT = 300_000;
const INITIAL_LIMIT = 100;

/** 設定の「デフォルト区切り文字」。auto と .tsv ファイルは Rust 側の自動判定に任せる */
function defaultDelimiterFor(filePath: string): string | undefined {
  const d = useSettingsStore.getState().csvSettings.defaultDelimiter;
  return d === "auto" || /\.tsv$/i.test(filePath) ? undefined : d;
}

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
    let cancelled = false;
    setLoading(tabId, true);
    const t0 = performance.now();
    invoke<CsvData>("read_csv", { path: filePath, limit: INITIAL_LIMIT, delimiter: defaultDelimiterFor(filePath) })
      .then(async (data) => {
        if (cancelled) return;
        console.info(`[perf] read_csv: ${(performance.now() - t0).toFixed(1)}ms`);
        setData(tabId, data);
        // タブ切替から戻ったときは、引き継いだ絞り込みを読み直した内容に掛け直す
        const filters = useCsvStore.getState().tabs[tabId]?.filters ?? [];
        if (filters.length === 0) return;
        const filtered = await invoke<CsvData>("filter_csv", {
          path: filePath,
          delimiter: data.meta.delimiter,
          conditions: filters,
        });
        if (!cancelled) useCsvStore.getState().setFilters(tabId, filters, filtered.rows, filtered.source_rows);
      })
      .catch((err) => { if (!cancelled) setError(tabId, String(err)); });
    return () => { cancelled = true; };
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
      delimiter: tab.data.meta.delimiter,
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
        .filter((f) => f.column_index !== cond.column_index)
        .concat(cond);

      setFiltering(tabId, true);
      try {
        const data = await invoke<CsvData>("filter_csv", {
          path: filePath,
          delimiter: tab.data?.meta.delimiter,
          conditions: newFilters,
        });
        setFilters(tabId, newFilters, data.rows, data.source_rows);
      } catch (err) {
        setFiltering(tabId, false);
        showError(`フィルタの適用に失敗しました: ${String(err)}`);
      }
    },
    [tabId, filePath]
  );

  // 単一列フィルタのクリア
  const handleFilterClearColumn = useCallback(
    async (columnIndex: number) => {
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab) return;
      const { setFiltering, setFilters, clearFilters } = useCsvStore.getState();

      const newFilters = tab.filters.filter((f) => f.column_index !== columnIndex);
      if (newFilters.length === 0) {
        clearFilters(tabId);
        return;
      }

      setFiltering(tabId, true);
      try {
        const data = await invoke<CsvData>("filter_csv", {
          path: filePath,
          delimiter: tab.data?.meta.delimiter,
          conditions: newFilters,
        });
        setFilters(tabId, newFilters, data.rows, data.source_rows);
      } catch (err) {
        setFiltering(tabId, false);
        showError(`フィルタのクリアに失敗しました: ${String(err)}`);
      }
    },
    [tabId, filePath]
  );

  // 全フィルタのクリア
  const handleClearAllFilters = useCallback(() => {
    useCsvStore.getState().clearFilters(tabId);
  }, [tabId]);

  // 並べ替え・検索は表示中の行だけを対象にするため、読み込み途中だと最初の数百行しか
  // 対象にならない。行数が多すぎなければ残りをすべて読み込み、多すぎる場合は対象範囲を知らせる
  const searchActive = useSearchStore((s) => s.isOpen && s.query !== "");
  const sortActive = tabState?.sort != null;
  const isLoadingChunk = tabState?.isLoadingChunk ?? false;
  useEffect(() => {
    if (!sortActive && !searchActive) return;
    const tab = useCsvStore.getState().tabs[tabId];
    if (!tab?.data || tab.filters.length > 0 || tab.isLoadingChunk) return;
    const total = tab.data.meta.total_rows;
    const remaining = total - tab.loadedRows;
    if (remaining <= 0) return;
    if (total > FULL_LOAD_LIMIT) {
      showWarning(
        `並べ替えと検索は読み込み済みの ${tab.loadedRows.toLocaleString()} 行が対象です（全 ${total.toLocaleString()} 行）`
      );
      return;
    }
    const { setLoadingChunk, appendRows } = useCsvStore.getState();
    setLoadingChunk(tabId, true);
    invoke<CsvChunk>("read_csv_chunk", {
      path: filePath,
      delimiter: tab.data.meta.delimiter,
      offset: tab.loadedRows,
      limit: remaining,
    })
      .then((chunk) => appendRows(tabId, chunk.rows, chunk.total_rows))
      .catch((err) => {
        setLoadingChunk(tabId, false);
        showError(`残りの行を読み込めませんでした: ${String(err)}`);
      });
  }, [tabId, filePath, sortActive, searchActive, isLoadingChunk]);

  // 表示行（フィルタ結果優先 → クライアントサイドソート）と、各行の元ファイルでの行番号
  const { displayRows, rowNumbers } = useMemo(() => {
    if (!tabState?.data) return { displayRows: [], rowNumbers: [] };
    const filtered = tabState.filteredRows;
    const rows = filtered ?? tabState.data.rows;
    const sources = (filtered && tabState.filteredSourceRows) || rows.map((_, i) => i);
    const sort = tabState.sort;
    const order = sort
      ? sortByColumn(rows.map((_, i) => i), (i) => rows[i][sort.columnIndex] ?? "", sort.direction)
      : rows.map((_, i) => i);
    return {
      displayRows: order.map((i) => rows[i]),
      rowNumbers: order.map((i) => sources[i] + 1),
    };
  }, [tabState?.data, tabState?.filteredRows, tabState?.filteredSourceRows, tabState?.sort]);

  // 検索ハイライト
  const searchIsOpen = useSearchStore((s) => s.isOpen);
  const searchQuery = useSearchStore((s) => s.query);
  const searchUseRegex = useSearchStore((s) => s.options.useRegex);
  const searchCaseSensitive = useSearchStore((s) => s.options.caseSensitive);
  const cellMatches = useSearchStore((s) => s.cellMatches);
  const currentMatchIndex = useSearchStore((s) => s.currentMatchIndex);
  const scrollToRowRef = useRef<((index: number) => void) | null>(null);

  const csvHeaders = useMemo(
    () => tabState?.data?.headers ?? [],
    [tabState?.data]
  );

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
      for (let c = 0; c < csvHeaders.length; c++) {
        regex.lastIndex = 0;
        if (regex.test(displayRows[r][c] ?? "")) matches.push({ row: r, col: c });
      }
    }
    useSearchStore.getState().setCellMatches(matches);
  }, [searchIsOpen, searchQuery, searchUseRegex, searchCaseSensitive, displayRows, csvHeaders]);

  useEffect(() => {
    const matches = useSearchStore.getState().cellMatches;
    if (matches.length === 0 || !scrollToRowRef.current) return;
    const match = matches[currentMatchIndex];
    if (match) scrollToRowRef.current(match.row);
  }, [currentMatchIndex]);

  const cellMatchSet = useMemo(() => {
    const set = new Set<string>();
    for (const m of cellMatches) set.add(`${m.row}:${m.col}`);
    return set;
  }, [cellMatches]);

  const currentMatch = cellMatches[currentMatchIndex] ?? null;

  const getCellStyleSearch = useCallback(
    (rowIdx: number, colIdx: number): React.CSSProperties => {
      if (currentMatch?.row === rowIdx && currentMatch?.col === colIdx)
        return { backgroundColor: "#f59e0b", color: "#000000" };
      if (cellMatchSet.has(`${rowIdx}:${colIdx}`))
        return { backgroundColor: "rgba(254,240,138,0.4)" };
      return {};
    },
    [cellMatchSet, currentMatch]
  );

  if (tabState?.error) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "#f87171" }}
      >
        エラー: {tabState.error}
      </div>
    );
  }

  // tabState 未初期化（初回 render）/ isLoading / data 未到着はすべて読み込み中表示にする
  if (!tabState || tabState.isLoading || !tabState.data) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "var(--text-secondary)" }}
      >
        読み込み中...
      </div>
    );
  }

  const { headers, meta } = tabState.data;

  // フィルタポップオーバーで表示する既存条件
  const existingFilter =
    filterColIndex !== null
      ? (tabState.filters.find((f) => f.column_index === filterColIndex) ?? null)
      : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* アクティブフィルタバー */}
      <ActiveFiltersBar
        filters={tabState.filters}
        filePath={filePath}
        delimiter={tabState.data.meta.delimiter}
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
        rowNumbers={rowNumbers}
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
        getCellStyle={getCellStyleSearch}
        scrollToRowRef={scrollToRowRef}
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
          columnIndex={filterColIndex}
          anchorRect={filterAnchorRect}
          existing={existingFilter}
          onApply={handleFilterApply}
          onClear={() => handleFilterClearColumn(filterColIndex)}
          onClose={() => {
            setFilterColIndex(null);
            setFilterAnchorRect(null);
          }}
        />
      )}
    </div>
  );
}
