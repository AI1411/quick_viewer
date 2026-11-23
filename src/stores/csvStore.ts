import { create } from "zustand";
import type { CsvData, FilterCondition } from "../types";

export type SortDirection = "asc" | "desc" | null;

export interface SortState {
  columnIndex: number;
  direction: SortDirection;
}

export interface SelectedCell {
  row: number; // data row index (0-based, after sorting)
  col: number; // column index (0-based, excluding row number col)
}

interface CsvTabState {
  data: CsvData | null;
  isLoading: boolean;
  error: string | null;
  // カラム幅 (px)。未設定は undefined = デフォルト幅使用
  columnWidths: Record<number, number>;
  // ソート状態
  sort: SortState | null;
  // ピン留め列数（左から N 列を固定）
  pinnedCount: number;
  // 選択セル（範囲選択は anchor + focus で表現）
  selectedAnchor: SelectedCell | null;
  selectedFocus: SelectedCell | null;
  // チャンク読み込み済み行数
  loadedRows: number;
  isLoadingChunk: boolean;
  // フィルタ状態
  filters: FilterCondition[];
  filteredRows: string[][] | null;
  isFiltering: boolean;
  // ソート結果（Rust が全行ソートした行。null = 未ソート / チャンク表示）
  sortedRows: string[][] | null;
  isSorting: boolean;
}

interface CsvStore {
  tabs: Record<string, CsvTabState>;
  initTab: (tabId: string) => void;
  setData: (tabId: string, data: CsvData) => void;
  setLoading: (tabId: string, isLoading: boolean) => void;
  setError: (tabId: string, error: string | null) => void;
  setColumnWidth: (tabId: string, colIndex: number, width: number) => void;
  setSort: (tabId: string, sort: SortState | null) => void;
  setPinnedCount: (tabId: string, count: number) => void;
  setSelection: (
    tabId: string,
    anchor: SelectedCell | null,
    focus: SelectedCell | null
  ) => void;
  appendRows: (tabId: string, rows: string[][], totalRows: number) => void;
  setLoadingChunk: (tabId: string, v: boolean) => void;
  removeTab: (tabId: string) => void;
  // フィルタ操作
  setFilters: (tabId: string, filters: FilterCondition[], filteredRows: string[][] | null) => void;
  setFiltering: (tabId: string, v: boolean) => void;
  clearFilters: (tabId: string) => void;
  // ソート結果
  setSortedRows: (tabId: string, sortedRows: string[][] | null) => void;
  setSorting: (tabId: string, v: boolean) => void;
  clearSortedRows: (tabId: string) => void;
}

const defaultTabState = (): CsvTabState => ({
  data: null,
  isLoading: true,
  error: null,
  columnWidths: {},
  sort: null,
  pinnedCount: 0,
  selectedAnchor: null,
  selectedFocus: null,
  loadedRows: 0,
  isLoadingChunk: false,
  filters: [],
  filteredRows: null,
  isFiltering: false,
  sortedRows: null,
  isSorting: false,
});

export const useCsvStore = create<CsvStore>((set) => ({
  tabs: {},

  initTab: (tabId) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: defaultTabState() },
    })),

  setData: (tabId, data) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          data,
          loadedRows: data.rows.length,
          isLoading: false,
        },
      },
    })),

  setLoading: (tabId, isLoading) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...state.tabs[tabId], isLoading } },
    })),

  setError: (tabId, error) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: { ...state.tabs[tabId], error, isLoading: false },
      },
    })),

  setColumnWidth: (tabId, colIndex, width) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          columnWidths: {
            ...state.tabs[tabId].columnWidths,
            [colIndex]: width,
          },
        },
      },
    })),

  setSort: (tabId, sort) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          sort,
          // clearing sort also drops cached sorted rows
          ...(sort === null ? { sortedRows: null, isSorting: false } : {}),
        },
      },
    })),

  setPinnedCount: (tabId, count) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: { ...state.tabs[tabId], pinnedCount: count },
      },
    })),

  setSelection: (tabId, anchor, focus) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          selectedAnchor: anchor,
          selectedFocus: focus,
        },
      },
    })),

  appendRows: (tabId, rows, totalRows) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab?.data) return {};
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            data: {
              ...tab.data,
              rows: [...tab.data.rows, ...rows],
              meta: { ...tab.data.meta, total_rows: totalRows },
            },
            loadedRows: tab.loadedRows + rows.length,
            isLoadingChunk: false,
          },
        },
      };
    }),

  setLoadingChunk: (tabId, v) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: { ...state.tabs[tabId], isLoadingChunk: v },
      },
    })),

  removeTab: (tabId) =>
    set((state) => {
      const next = { ...state.tabs };
      delete next[tabId];
      return { tabs: next };
    }),

  setFilters: (tabId, filters, filteredRows) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          filters,
          filteredRows,
          isFiltering: false,
        },
      },
    })),

  setFiltering: (tabId, v) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: { ...state.tabs[tabId], isFiltering: v },
      },
    })),

  clearFilters: (tabId) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          filters: [],
          filteredRows: null,
          isFiltering: false,
        },
      },
    })),

  setSortedRows: (tabId, sortedRows) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          sortedRows,
          isSorting: false,
        },
      },
    })),

  setSorting: (tabId, v) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: { ...state.tabs[tabId], isSorting: v },
      },
    })),

  clearSortedRows: (tabId) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          sortedRows: null,
          isSorting: false,
        },
      },
    })),
}));
