import { create } from "zustand";
import type { XlsxInfo, XlsxSheetData, FilterCondition, ScrollPosition } from "../types";

export type XlsxSortDirection = "asc" | "desc" | null;

export interface XlsxSortState {
  columnIndex: number;
  direction: XlsxSortDirection;
}

export interface XlsxSelectedCell {
  row: number;
  col: number;
}

interface XlsxTabState {
  info: XlsxInfo | null;
  sheetData: XlsxSheetData | null;
  activeSheetName: string | null;
  isLoading: boolean;
  error: string | null;
  columnWidths: Record<number, number>;
  sort: XlsxSortState | null;
  filters: FilterCondition[];
  /** 表を最後に閉じたときのスクロール位置。同じシートを読み直したときに、ここから表示し直す */
  scroll: ScrollPosition | null;
  selectedAnchor: XlsxSelectedCell | null;
  selectedFocus: XlsxSelectedCell | null;
}

interface XlsxStore {
  tabs: Record<string, XlsxTabState>;
  initTab: (tabId: string) => void;
  setInfo: (tabId: string, info: XlsxInfo) => void;
  setSheetData: (tabId: string, sheetData: XlsxSheetData, sheetName: string) => void;
  setLoading: (tabId: string, isLoading: boolean) => void;
  setError: (tabId: string, error: string | null) => void;
  setColumnWidth: (tabId: string, colIndex: number, width: number) => void;
  setSort: (tabId: string, sort: XlsxSortState | null) => void;
  setFilters: (tabId: string, filters: FilterCondition[]) => void;
  clearFilters: (tabId: string) => void;
  keepScroll: (tabId: string, scroll: ScrollPosition) => void;
  setSelection: (
    tabId: string,
    anchor: XlsxSelectedCell | null,
    focus: XlsxSelectedCell | null
  ) => void;
  removeTab: (tabId: string) => void;
}

const defaultTabState = (): XlsxTabState => ({
  info: null,
  sheetData: null,
  activeSheetName: null,
  isLoading: false,
  error: null,
  columnWidths: {},
  sort: null,
  filters: [],
  scroll: null,
  selectedAnchor: null,
  selectedFocus: null,
});

export const useXlsxStore = create<XlsxStore>((set) => ({
  tabs: {},

  // 再読み込み (ファイルの外部変更の反映) でビューアがマウントし直されたときは、
  // 表示中のシートと並べ替え・絞り込み・列幅・スクロール位置を引き継ぐ。シートのデータは読み直す
  initTab: (tabId) =>
    set((state) => {
      const prev = state.tabs[tabId];
      const next = defaultTabState();
      return {
        tabs: {
          ...state.tabs,
          [tabId]: prev
            ? {
                ...next,
                activeSheetName: prev.activeSheetName,
                sort: prev.sort,
                filters: prev.filters,
                columnWidths: prev.columnWidths,
                scroll: prev.scroll,
              }
            : next,
        },
      };
    }),

  setInfo: (tabId, info) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...state.tabs[tabId], info } },
    })),

  // 別のシートに切り替えたときは並べ替え・絞り込み・列幅・スクロール位置をリセットする。
  // 同じシートを読み直したとき (再読み込み) は引き継ぎ、列が減って当てはまらなくなったものだけ外す
  setSheetData: (tabId, sheetData, sheetName) =>
    set((state) => {
      const prev = state.tabs[tabId];
      const sameSheet = prev?.activeSheetName === sheetName;
      const columns = sheetData.loaded_cols ?? sheetData.total_cols;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...prev,
            sheetData,
            activeSheetName: sheetName,
            isLoading: false,
            error: null,
            columnWidths: sameSheet ? prev.columnWidths : {},
            sort: sameSheet && prev.sort && prev.sort.columnIndex < columns ? prev.sort : null,
            filters: sameSheet
              ? prev.filters.filter((f) => f.column_index == null || f.column_index < columns)
              : [],
            scroll: sameSheet ? prev.scroll : null,
            selectedAnchor: null,
            selectedFocus: null,
          },
        },
      };
    }),

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
          columnWidths: { ...state.tabs[tabId].columnWidths, [colIndex]: width },
        },
      },
    })),

  setSort: (tabId, sort) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...state.tabs[tabId], sort } },
    })),

  setFilters: (tabId, filters) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...state.tabs[tabId], filters } },
    })),

  clearFilters: (tabId) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...state.tabs[tabId], filters: [] } },
    })),

  // データを表示していた表の位置だけを覚える。再読み込みの直後は、作り直されたビューアが
  // 読み直す前のデータで表を一瞬だけ描画し、その表も自分の位置を通知してくる。
  // それで引き継ぐ位置を上書きしないよう、データを捨てた後の通知は受け取らない
  keepScroll: (tabId, scroll) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab?.sheetData) return state;
      return { tabs: { ...state.tabs, [tabId]: { ...tab, scroll } } };
    }),

  setSelection: (tabId, anchor, focus) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: { ...state.tabs[tabId], selectedAnchor: anchor, selectedFocus: focus },
      },
    })),

  removeTab: (tabId) =>
    set((state) => {
      const next = { ...state.tabs };
      delete next[tabId];
      return { tabs: next };
    }),
}));
