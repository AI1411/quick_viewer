import { useEffect, useCallback, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCsvStore } from "../../stores/csvStore";
import { useSearchStore } from "../../stores/searchStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { showError } from "../../stores/toastStore";
import type { CellMatch } from "../../stores/searchStore";
import { VirtualTable } from "./VirtualTable";
import { FilterPopover } from "./FilterPopover";
import { ActiveFiltersBar } from "./ActiveFiltersBar";
import { StatusBar } from "./StatusBar";
import type { CsvData, CsvChunk, FilterCondition } from "../../types";
import type React from "react";

const CHUNK_SIZE = 200;
const INITIAL_LIMIT = 100;

/** Settings "auto" → null so Rust auto-detects; otherwise the chosen delimiter char. */
function csvDelimiterFromSettings(): string | null {
  const d = useSettingsStore.getState().csvSettings.defaultDelimiter;
  return d === "auto" ? null : d;
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
    const delimiter = csvDelimiterFromSettings();
    invoke<CsvData>("read_csv", { path: filePath, delimiter, limit: INITIAL_LIMIT })
      .then((data) => {
        if (cancelled) return;
        console.info(`[perf] read_csv: ${(performance.now() - t0).toFixed(1)}ms`);
        setData(tabId, data);
      })
      .catch((err) => { if (!cancelled) setError(tabId, String(err)); });
    return () => { cancelled = true; };
  }, [tabId, filePath]);

  // アンマウント時にストア状態をクリーンアップ
  useEffect(() => {
    return () => {
      useCsvStore.getState().removeTab(tabId);
    };
  }, [tabId]);

  // チャンク追加読み込み（フィルタ / ソート中は全行取得済みなので無効）
  const handleScrollEnd = useCallback(() => {
    const tab = useCsvStore.getState().tabs[tabId];
    if (!tab || tab.isLoadingChunk || !tab.data) return;
    if (tab.filters.length > 0 || tab.sort || tab.sortedRows) return;
    if (tab.loadedRows >= tab.data.meta.total_rows) return;

    const { setLoadingChunk, appendRows } = useCsvStore.getState();
    setLoadingChunk(tabId, true);
    invoke<CsvChunk>("read_csv_chunk", {
      path: filePath,
      delimiter: csvDelimiterFromSettings(),
      offset: tab.loadedRows,
      limit: CHUNK_SIZE,
    })
      .then((chunk) => appendRows(tabId, chunk.rows, chunk.total_rows))
      .catch(() => setLoadingChunk(tabId, false));
  }, [tabId, filePath]);

  // ソート切り替え（Rust sort_csv で全行ソート）
  const handleSort = useCallback(
    async (colIndex: number) => {
      const store = useCsvStore.getState();
      const tab = store.tabs[tabId];
      if (!tab) return;

      const current = tab.sort;
      let next: { columnIndex: number; direction: "asc" | "desc" } | null;
      if (!current || current.columnIndex !== colIndex) {
        next = { columnIndex: colIndex, direction: "asc" };
      } else if (current.direction === "asc") {
        next = { columnIndex: colIndex, direction: "desc" };
      } else {
        next = null;
      }

      if (!next) {
        store.setSort(tabId, null);
        return;
      }

      store.setSorting(tabId, true);
      store.setSort(tabId, next);
      try {
        const data = await invoke<CsvData>("sort_csv", {
          path: filePath,
          delimiter: csvDelimiterFromSettings(),
          column_index: next.columnIndex,
          ascending: next.direction === "asc",
          conditions: tab.filters.length > 0 ? tab.filters : null,
        });
        useCsvStore.getState().setSortedRows(tabId, data.rows);
      } catch (err) {
        useCsvStore.getState().setSorting(tabId, false);
        useCsvStore.getState().setSort(tabId, null);
        showError(`ソートに失敗しました: ${String(err)}`);
      }
    },
    [tabId, filePath]
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

  // フィルタ適用後にソートが有効なら sort_csv、なければ filter_csv
  const applyFiltersWithOptionalSort = useCallback(
    async (newFilters: FilterCondition[]) => {
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab?.data) return;
      const { setFiltering, setFilters, setSorting, setSortedRows } =
        useCsvStore.getState();

      setFiltering(tabId, true);
      try {
        const delimiter = csvDelimiterFromSettings();
        if (tab.sort) {
          setSorting(tabId, true);
          const data = await invoke<CsvData>("sort_csv", {
            path: filePath,
            delimiter,
            column_index: tab.sort.columnIndex,
            ascending: tab.sort.direction === "asc",
            conditions: newFilters.length > 0 ? newFilters : null,
          });
          setFilters(tabId, newFilters, newFilters.length > 0 ? data.rows : null);
          setSortedRows(tabId, data.rows);
        } else {
          const data = await invoke<CsvData>("filter_csv", {
            path: filePath,
            delimiter,
            conditions: newFilters,
          });
          setFilters(tabId, newFilters, data.rows);
        }
      } catch (err) {
        setFiltering(tabId, false);
        setSorting(tabId, false);
        showError(`フィルタの適用に失敗しました: ${String(err)}`);
      }
    },
    [tabId, filePath]
  );

  // フィルタ適用（Rust filter_csv / sort_csv を呼び出して結果を store に保存）
  const handleFilterApply = useCallback(
    async (cond: FilterCondition) => {
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab?.data) return;
      const newFilters = tab.filters
        .filter((f) => f.column !== cond.column)
        .concat(cond);
      await applyFiltersWithOptionalSort(newFilters);
    },
    [tabId, applyFiltersWithOptionalSort]
  );

  // 単一列フィルタのクリア
  const handleFilterClearColumn = useCallback(
    async (column: string) => {
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab) return;
      const { clearFilters, setSort, setSortedRows, setSorting } =
        useCsvStore.getState();

      const newFilters = tab.filters.filter((f) => f.column !== column);
      if (newFilters.length === 0) {
        clearFilters(tabId);
        // ソートが残っていれば全行で再ソート
        if (tab.sort) {
          setSorting(tabId, true);
          try {
            const data = await invoke<CsvData>("sort_csv", {
              path: filePath,
              delimiter: csvDelimiterFromSettings(),
              column_index: tab.sort.columnIndex,
              ascending: tab.sort.direction === "asc",
              conditions: null,
            });
            setSortedRows(tabId, data.rows);
          } catch (err) {
            setSorting(tabId, false);
            setSort(tabId, null);
            showError(`ソートの再適用に失敗しました: ${String(err)}`);
          }
        }
        return;
      }

      await applyFiltersWithOptionalSort(newFilters);
    },
    [tabId, filePath, applyFiltersWithOptionalSort]
  );

  // 全フィルタのクリア
  const handleClearAllFilters = useCallback(async () => {
    const tab = useCsvStore.getState().tabs[tabId];
    useCsvStore.getState().clearFilters(tabId);
    if (!tab?.sort) return;
    const { setSorting, setSortedRows, setSort } = useCsvStore.getState();
    setSorting(tabId, true);
    try {
      const data = await invoke<CsvData>("sort_csv", {
        path: filePath,
        delimiter: csvDelimiterFromSettings(),
        column_index: tab.sort.columnIndex,
        ascending: tab.sort.direction === "asc",
        conditions: null,
      });
      setSortedRows(tabId, data.rows);
    } catch (err) {
      setSorting(tabId, false);
      setSort(tabId, null);
      showError(`ソートの再適用に失敗しました: ${String(err)}`);
    }
  }, [tabId, filePath]);

  // 表示行（ソート結果 → フィルタ結果 → チャンク読み込み行）
  const displayRows = useMemo(() => {
    if (!tabState?.data) return [];
    return tabState.sortedRows ?? tabState.filteredRows ?? tabState.data.rows;
  }, [tabState?.data, tabState?.filteredRows, tabState?.sortedRows]);

  // 検索ハイライト（Rust search_csv で全行検索）
  const searchIsOpen = useSearchStore((s) => s.isOpen);
  const searchQuery = useSearchStore((s) => s.query);
  const searchUseRegex = useSearchStore((s) => s.options.useRegex);
  const searchCaseSensitive = useSearchStore((s) => s.options.caseSensitive);
  const cellMatches = useSearchStore((s) => s.cellMatches);
  const currentMatchIndex = useSearchStore((s) => s.currentMatchIndex);
  const scrollToRowRef = useRef<((index: number) => void) | null>(null);

  // ソート中に全行が揃っていない場合、検索のために全行をロードして sortedRows 相当を確保
  useEffect(() => {
    if (!searchIsOpen || !searchQuery) {
      useSearchStore.getState().setCellMatches([]);
      return;
    }

    let cancelled = false;
    const tab = useCsvStore.getState().tabs[tabId];
    if (!tab?.data) return;

    const run = async () => {
      // チャンク表示のみ（全行未取得）のときは search と同時に全行を取得して表示に使う
      const needsFullLoad =
        !tab.sortedRows &&
        !tab.filteredRows &&
        tab.loadedRows < tab.data!.meta.total_rows;

      try {
        if (needsFullLoad) {
          // sort_csv with current no-op isn't available; load via filter_csv empty → all rows
          // Prefer sort if active, else filter_csv with empty conditions returns all rows.
          const delimiter = csvDelimiterFromSettings();
          const data = tab.sort
            ? await invoke<CsvData>("sort_csv", {
                path: filePath,
                delimiter,
                column_index: tab.sort.columnIndex,
                ascending: tab.sort.direction === "asc",
                conditions: null,
              })
            : await invoke<CsvData>("filter_csv", {
                path: filePath,
                delimiter,
                conditions: [],
              });
          if (cancelled) return;
          if (tab.sort) {
            useCsvStore.getState().setSortedRows(tabId, data.rows);
          } else {
            // stash full rows into data so displayRows covers the file
            useCsvStore.getState().setData(tabId, {
              ...tab.data!,
              rows: data.rows,
              meta: { ...tab.data!.meta, total_rows: data.meta.total_rows },
            });
          }
        }

        const latest = useCsvStore.getState().tabs[tabId];
        const matches = await invoke<CellMatch[]>("search_csv", {
          path: filePath,
          delimiter: csvDelimiterFromSettings(),
          query: searchQuery,
          use_regex: searchUseRegex,
          case_sensitive: searchCaseSensitive,
          conditions: latest?.filters.length ? latest.filters : null,
          sort_column_index: latest?.sort?.columnIndex ?? null,
          sort_ascending:
            latest?.sort != null ? latest.sort.direction === "asc" : null,
        });
        if (!cancelled) {
          useSearchStore.getState().setCellMatches(matches);
        }
      } catch (err) {
        if (!cancelled) {
          useSearchStore.getState().setCellMatches([]);
          showError(`検索に失敗しました: ${String(err)}`);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    searchIsOpen,
    searchQuery,
    searchUseRegex,
    searchCaseSensitive,
    tabId,
    filePath,
    tabState?.sort,
    tabState?.filters,
    tabState?.sortedRows,
    tabState?.filteredRows,
    tabState?.loadedRows,
    tabState?.data?.meta.total_rows,
  ]);

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
      ? (tabState.filters.find((f) => f.column === headers[filterColIndex]) ?? null)
      : null;

  const viewRowCount = displayRows.length;
  const totalRowsForTable =
    tabState.sortedRows || tabState.filteredRows
      ? viewRowCount
      : meta.total_rows;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* アクティブフィルタバー */}
      <ActiveFiltersBar
        filters={tabState.filters}
        filePath={filePath}
        delimiter={csvDelimiterFromSettings()}
        onClearFilter={handleFilterClearColumn}
        onClearAll={handleClearAllFilters}
      />

      {/* フィルタ / ソート中インジケータ */}
      {(tabState.isFiltering || tabState.isSorting) && (
        <div
          className="flex items-center justify-center text-xs py-1 flex-shrink-0"
          style={{ color: "var(--text-secondary)", backgroundColor: "var(--tabbar-bg)" }}
        >
          {tabState.isSorting ? "ソート適用中..." : "フィルタ適用中..."}
        </div>
      )}

      <VirtualTable
        headers={headers}
        rows={displayRows}
        totalRows={totalRowsForTable}
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
        loadedRows={
          tabState.sortedRows
            ? tabState.sortedRows.length
            : tabState.filteredRows
              ? tabState.filteredRows.length
              : tabState.loadedRows
        }
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
