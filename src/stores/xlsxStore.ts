import { create } from "zustand";
import type { XlsxInfo, XlsxSheetData, FilterCondition } from "../types";

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
  selectedAnchor: null,
  selectedFocus: null,
});

export const useXlsxStore = create<XlsxStore>((set) => ({
  tabs: {},

  // タブを切り替えて戻ったときは、表示中のシートと並べ替え・絞り込み・列幅を引き継ぐ
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
              }
            : next,
        },
      };
    }),

  setInfo: (tabId, info) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...state.tabs[tabId], info } },
    })),

  // 別のシートに切り替えたときだけ並べ替え・絞り込み・列幅をリセットする
  setSheetData: (tabId, sheetData, sheetName) =>
    set((state) => {
      const prev = state.tabs[tabId];
      const sameSheet = prev?.activeSheetName === sheetName;
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
            sort: sameSheet ? prev.sort : null,
            filters: sameSheet ? prev.filters : [],
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
