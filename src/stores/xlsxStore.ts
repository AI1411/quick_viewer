import { create } from "zustand";
import type { XlsxInfo, XlsxSheetData } from "../types";

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
  selectedAnchor: null,
  selectedFocus: null,
});

export const useXlsxStore = create<XlsxStore>((set) => ({
  tabs: {},

  initTab: (tabId) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: defaultTabState() },
    })),

  setInfo: (tabId, info) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...state.tabs[tabId], info } },
    })),

  setSheetData: (tabId, sheetData, sheetName) =>
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...state.tabs[tabId],
          sheetData,
          activeSheetName: sheetName,
          isLoading: false,
          columnWidths: {},
          sort: null,
          selectedAnchor: null,
          selectedFocus: null,
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
          columnWidths: { ...state.tabs[tabId].columnWidths, [colIndex]: width },
        },
      },
    })),

  setSort: (tabId, sort) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...state.tabs[tabId], sort } },
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
