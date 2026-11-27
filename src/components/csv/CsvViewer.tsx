import { useEffect, useCallback, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCsvStore } from "../../stores/csvStore";
import { useSearchStore } from "../../stores/searchStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { showError } from "../../stores/toastStore";
import type { CellMatch } from "../../stores/searchStore";
import { VirtualTable, ROW_HEIGHT } from "./VirtualTable";
import { FilterPopover } from "./FilterPopover";
import { ActiveFiltersBar } from "./ActiveFiltersBar";
import { StatusBar } from "./StatusBar";
import type { CsvData, CsvChunk, FilterCondition, ScrollPosition } from "../../types";
import type React from "react";

const CHUNK_SIZE = 200;
const INITIAL_LIMIT = 100;

/**
 * Rust に渡す区切り文字。.tsv は設定に関係なくタブ区切りとして読む
 * (既定の区切り文字を "," などに固定していると、TSV が 1 列になってしまう)。
 * それ以外は設定に従い、"auto" なら null を渡して Rust に判定させる。
 */
function csvDelimiter(filePath: string): string | null {
  if (/\.tsv$/i.test(filePath)) return "\t";
  const d = useSettingsStore.getState().csvSettings.defaultDelimiter;
  return d === "auto" ? null : d;
}

interface CsvViewerProps {
  tabId: string;
  filePath: string;
  isActive?: boolean;
}

export function CsvViewer({ tabId, filePath, isActive = true }: CsvViewerProps) {
  const tabState = useCsvStore((s) => s.tabs[tabId]);

  // フィルタポップオーバーの表示状態
  const [filterColIndex, setFilterColIndex] = useState<number | null>(null);
  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(null);

  // 初期化 & 索引付き読み込み（Rust 側で CsvIndex を構築・キャッシュ）
  useEffect(() => {
    const { initTab, setFilePath, setLoading, setData, setError } =
      useCsvStore.getState();
    initTab(tabId);
    setFilePath(tabId, filePath);
    let cancelled = false;
    setLoading(tabId, true);
    const t0 = performance.now();
    const delimiter = csvDelimiter(filePath);
    // 再読み込みでは、引き継いだスクロール位置の行までまとめて読む。先頭の 100 行だけだと、
    // 続きを 200 行ずつ読み足す間、表示位置の行が空のままになる。
    // 並べ替えや絞り込みを引き継ぐときは、適用し直した結果が全行を返すので読み足さない
    const kept = useCsvStore.getState().tabs[tabId];
    const keepsView = Boolean(kept?.sort) || (kept?.filters.length ?? 0) > 0;
    const keptRow = keepsView ? 0 : Math.floor((kept?.scroll?.top ?? 0) / ROW_HEIGHT);
    invoke<CsvData>("read_csv", { path: filePath, delimiter, limit: INITIAL_LIMIT + keptRow })
      .then((data) => {
        if (cancelled) return;
        console.info(`[perf] read_csv (indexed): ${(performance.now() - t0).toFixed(1)}ms`);
        setData(tabId, data);
        return reapplyKeptView(data.headers);
      })
      .catch((err) => { if (!cancelled) setError(tabId, String(err)); });

    // 再読み込みで引き継いだ並べ替えと絞り込みを、読み直したデータに適用し直す
    async function reapplyKeptView(headers: string[]) {
      const store = useCsvStore.getState();
      const kept = store.tabs[tabId];
      if (!kept || (kept.filters.length === 0 && !kept.sort)) return;
      const reset = () => {
        useCsvStore.getState().clearFilters(tabId);
        useCsvStore.getState().setSort(tabId, null);
      };
      // ファイルの列が変わって当てはまらなくなったものは捨てる
      const filters = kept.filters.filter((f) =>
        f.column_index != null ? headers[f.column_index] === f.column : headers.includes(f.column)
      );
      const sort = kept.sort && kept.sort.columnIndex < headers.length ? kept.sort : null;
      if (filters.length === 0 && !sort) return reset();
      try {
        const result = sort
          ? await invoke<CsvData>("sort_csv", {
              path: filePath,
              delimiter,
              columnIndex: sort.columnIndex,
              ascending: sort.direction === "asc",
              conditions: filters.length > 0 ? filters : null,
            })
          : await invoke<CsvData>("filter_csv", { path: filePath, delimiter, conditions: filters });
        if (cancelled) return;
        store.setSort(tabId, sort);
        store.setFilters(tabId, filters, sort && filters.length === 0 ? null : result.rows, result.source_rows);
        if (sort) store.setSortedRows(tabId, result.rows, result.source_rows);
      } catch {
        // 外したままにしないと、並べ替え中とみなされて続きの行が読み込まれない
        if (!cancelled) reset();
      }
    }
    return () => { cancelled = true; };
  }, [tabId, filePath]);

  const keepScroll = useCallback(
    (position: ScrollPosition) => useCsvStore.getState().keepScroll(tabId, position),
    [tabId]
  );

  // チャンク追加読み込み（索引シーク。フィルタ / ソート中は全行取得済みなので無効）
  const handleScrollEnd = useCallback(() => {
    const tab = useCsvStore.getState().tabs[tabId];
    if (!tab || tab.isLoadingChunk || !tab.data) return;
    if (tab.filters.length > 0 || tab.sort || tab.sortedRows) return;
    if (tab.loadedRows >= tab.data.meta.total_rows) return;

    const { setLoadingChunk, appendRows } = useCsvStore.getState();
    setLoadingChunk(tabId, true);
    const t0 = performance.now();
    invoke<CsvChunk>("read_csv_chunk", {
      path: filePath,
      delimiter: csvDelimiter(filePath),
      offset: tab.loadedRows,
      limit: CHUNK_SIZE,
    })
      .then((chunk) => {
        console.info(
          `[perf] read_csv_chunk offset=${chunk.offset}: ${(performance.now() - t0).toFixed(1)}ms`
        );
        appendRows(tabId, chunk.rows, chunk.total_rows);
      })
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
          delimiter: csvDelimiter(filePath),
          columnIndex: next.columnIndex,
          ascending: next.direction === "asc",
          conditions: tab.filters.length > 0 ? tab.filters : null,
        });
        useCsvStore.getState().setSortedRows(tabId, data.rows, data.source_rows);
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
        const delimiter = csvDelimiter(filePath);
        if (tab.sort) {
          setSorting(tabId, true);
          const data = await invoke<CsvData>("sort_csv", {
            path: filePath,
            delimiter,
            columnIndex: tab.sort.columnIndex,
            ascending: tab.sort.direction === "asc",
            conditions: newFilters.length > 0 ? newFilters : null,
          });
          setFilters(
            tabId,
            newFilters,
            newFilters.length > 0 ? data.rows : null,
            data.source_rows
          );
          setSortedRows(tabId, data.rows, data.source_rows);
        } else {
          const data = await invoke<CsvData>("filter_csv", {
            path: filePath,
            delimiter,
            conditions: newFilters,
          });
          setFilters(tabId, newFilters, data.rows, data.source_rows);
        }
      } catch (err) {
        setFiltering(tabId, false);
        setSorting(tabId, false);
        showError(`フィルタの適用に失敗しました: ${String(err)}`);
      }
    },
    [tabId, filePath]
  );

  // フィルタ適用（列番号付き。Rust filter_csv / sort_csv を呼び出して結果を store に保存）
  const handleFilterApply = useCallback(
    async (cond: FilterCondition) => {
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab?.data) return;
      const colIdx =
        cond.column_index ??
        filterColIndex ??
        tab.data.headers.indexOf(cond.column);
      const withIndex: FilterCondition = {
        ...cond,
        column_index: colIdx >= 0 ? colIdx : undefined,
      };
      const newFilters = tab.filters
        .filter((f) =>
          withIndex.column_index != null
            ? f.column_index !== withIndex.column_index
            : f.column !== withIndex.column
        )
        .concat(withIndex);
      await applyFiltersWithOptionalSort(newFilters);
    },
    [tabId, filterColIndex, applyFiltersWithOptionalSort]
  );

  // 単一列フィルタのクリア（同じ名前の列があり得るので、列名ではなく条件そのもので特定する）
  const handleFilterClear = useCallback(
    async (target: FilterCondition) => {
      const tab = useCsvStore.getState().tabs[tabId];
      if (!tab) return;
      const { clearFilters, setSort, setSortedRows, setSorting } =
        useCsvStore.getState();

      const newFilters = tab.filters.filter((f) => f !== target);
      if (newFilters.length === 0) {
        clearFilters(tabId);
        // ソートが残っていれば全行で再ソート
        if (tab.sort) {
          setSorting(tabId, true);
          try {
            const data = await invoke<CsvData>("sort_csv", {
              path: filePath,
              delimiter: csvDelimiter(filePath),
              columnIndex: tab.sort.columnIndex,
              ascending: tab.sort.direction === "asc",
              conditions: null,
            });
            setSortedRows(tabId, data.rows, data.source_rows);
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
        delimiter: csvDelimiter(filePath),
        columnIndex: tab.sort.columnIndex,
        ascending: tab.sort.direction === "asc",
        conditions: null,
      });
      setSortedRows(tabId, data.rows, data.source_rows);
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

  // 並べ替え・絞り込み後も、各行には元ファイルでの行番号を表示する
  const rowNumbers = useMemo(() => {
    const sourceRows = tabState?.sortedRows
      ? tabState.sortedSourceRows
      : tabState?.filteredRows
        ? tabState.filteredSourceRows
        : null;
    return sourceRows?.map((i) => i + 1);
  }, [
    tabState?.sortedRows,
    tabState?.sortedSourceRows,
    tabState?.filteredRows,
    tabState?.filteredSourceRows,
  ]);

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
    if (!isActive) return;
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
          const delimiter = csvDelimiter(filePath);
          const data = tab.sort
            ? await invoke<CsvData>("sort_csv", {
                path: filePath,
                delimiter,
                columnIndex: tab.sort.columnIndex,
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
            useCsvStore.getState().setSortedRows(tabId, data.rows, data.source_rows);
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
          delimiter: csvDelimiter(filePath),
          query: searchQuery,
          useRegex: searchUseRegex,
          caseSensitive: searchCaseSensitive,
          conditions: latest?.filters.length ? latest.filters : null,
          sortColumnIndex: latest?.sort?.columnIndex ?? null,
          sortAscending:
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
    isActive,
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
    if (!isActive) return;
    const matches = useSearchStore.getState().cellMatches;
    if (matches.length === 0 || !scrollToRowRef.current) return;
    const match = matches[currentMatchIndex];
    if (match) scrollToRowRef.current(match.row);
  }, [isActive, currentMatchIndex]);

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
        delimiter={csvDelimiter(filePath)}
        onClearFilter={handleFilterClear}
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
        rowNumbers={rowNumbers}
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
        initialScroll={tabState.scroll}
        onScrollKeep={keepScroll}
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
          columnIndex={filterColIndex}
          anchorRect={filterAnchorRect}
          existing={existingFilter}
          onApply={handleFilterApply}
          onClear={() => {
            if (existingFilter) void handleFilterClear(existingFilter);
          }}
          onClose={() => {
            setFilterColIndex(null);
            setFilterAnchorRect(null);
          }}
        />
      )}
    </div>
  );
}
