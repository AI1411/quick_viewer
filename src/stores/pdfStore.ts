import { create } from "zustand";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfInfo, PdfDisplayMode } from "../types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;

interface PdfTabState {
  pdfInfo: PdfInfo | null;
  pdfDocument: PDFDocumentProxy | null;
  currentPage: number; // 1-based
  zoom: number; // 1.0 = 100%
  rotation: number; // 0 | 90 | 180 | 270
  displayMode: PdfDisplayMode;
  isSidebarOpen: boolean;
  sidebarMode: "thumbnail" | "outline";
  isLoading: boolean;
  error: string | null;
}

interface PdfStore {
  tabs: Record<string, PdfTabState>;
  initTab: (tabId: string) => void;
  removeTab: (tabId: string) => void;
  setPdfInfo: (tabId: string, info: PdfInfo) => void;
  setPdfDocument: (tabId: string, doc: PDFDocumentProxy) => void;
  setCurrentPage: (tabId: string, page: number) => void;
  setZoom: (tabId: string, zoom: number) => void;
  setRotation: (tabId: string, rotation: number) => void;
  setDisplayMode: (tabId: string, mode: PdfDisplayMode) => void;
  toggleSidebar: (tabId: string) => void;
  setSidebarMode: (tabId: string, mode: "thumbnail" | "outline") => void;
  setLoading: (tabId: string, loading: boolean) => void;
  setError: (tabId: string, error: string | null) => void;
}

const defaultTabState = (): PdfTabState => ({
  pdfInfo: null,
  pdfDocument: null,
  currentPage: 1,
  zoom: 1.0,
  rotation: 0,
  displayMode: "single",
  isSidebarOpen: true,
  sidebarMode: "thumbnail",
  isLoading: false,
  error: null,
});

function patch(state: PdfStore, tabId: string, updates: Partial<PdfTabState>) {
  return {
    tabs: {
      ...state.tabs,
      [tabId]: { ...state.tabs[tabId], ...updates },
    },
  };
}

export const usePdfStore = create<PdfStore>((set) => ({
  tabs: {},

  initTab: (tabId) =>
    set((s) => ({ tabs: { ...s.tabs, [tabId]: defaultTabState() } })),

  removeTab: (tabId) =>
    set((s) => {
      const next = { ...s.tabs };
      delete next[tabId];
      return { tabs: next };
    }),

  setPdfInfo: (tabId, pdfInfo) => set((s) => patch(s, tabId, { pdfInfo })),

  setPdfDocument: (tabId, pdfDocument) =>
    set((s) => patch(s, tabId, { pdfDocument })),

  setCurrentPage: (tabId, page) =>
    set((s) => patch(s, tabId, { currentPage: page })),

  setZoom: (tabId, zoom) =>
    set((s) =>
      patch(s, tabId, { zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) })
    ),

  setRotation: (tabId, rotation) =>
    set((s) => patch(s, tabId, { rotation: ((rotation % 360) + 360) % 360 })),

  setDisplayMode: (tabId, displayMode) =>
    set((s) => patch(s, tabId, { displayMode })),

  toggleSidebar: (tabId) =>
    set((s) =>
      patch(s, tabId, { isSidebarOpen: !s.tabs[tabId]?.isSidebarOpen })
    ),

  setSidebarMode: (tabId, sidebarMode) =>
    set((s) => patch(s, tabId, { sidebarMode })),

  setLoading: (tabId, isLoading) =>
    set((s) => patch(s, tabId, { isLoading })),

  setError: (tabId, error) =>
    set((s) => patch(s, tabId, { error, isLoading: false })),
}));
