import { create } from "zustand";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfInfo, PdfDisplayMode, Annotation, AnnotationColor } from "../types";
import { useSettingsStore } from "./settingsStore";

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
  annotations: Record<number, Annotation[]>; // pageIndex -> annotations
  annotationMode: "none" | "highlight" | "note";
  selectedAnnotationId: string | null;
  highlightColor: AnnotationColor;
}

interface PdfStore {
  tabs: Record<string, PdfTabState>;
  initTab: (tabId: string) => void;
  removeTab: (tabId: string) => void;
  setPdfInfo: (tabId: string, info: PdfInfo) => void;
  setPdfDocument: (tabId: string, doc: PDFDocumentProxy | null) => void;
  setCurrentPage: (tabId: string, page: number) => void;
  setZoom: (tabId: string, zoom: number) => void;
  setRotation: (tabId: string, rotation: number) => void;
  setDisplayMode: (tabId: string, mode: PdfDisplayMode) => void;
  toggleSidebar: (tabId: string) => void;
  setSidebarMode: (tabId: string, mode: "thumbnail" | "outline") => void;
  setLoading: (tabId: string, loading: boolean) => void;
  setError: (tabId: string, error: string | null) => void;
  addAnnotation: (tabId: string, annotation: Annotation) => void;
  deleteAnnotation: (tabId: string, pageIndex: number, annotationId: string) => void;
  setAnnotations: (tabId: string, annotations: Annotation[]) => void;
  setAnnotationMode: (tabId: string, mode: "none" | "highlight" | "note") => void;
  setSelectedAnnotationId: (tabId: string, id: string | null) => void;
  setHighlightColor: (tabId: string, color: AnnotationColor) => void;
}

const defaultTabState = (): PdfTabState => ({
  pdfInfo: null,
  pdfDocument: null,
  currentPage: 1,
  zoom: 1.0,
  rotation: 0,
  displayMode: useSettingsStore.getState().pdfSettings.defaultViewMode,
  isSidebarOpen: true,
  sidebarMode: "thumbnail",
  isLoading: false,
  error: null,
  annotations: {},
  annotationMode: "none",
  selectedAnnotationId: null,
  highlightColor: "yellow",
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

  // 再読み込み (ファイルの外部変更の反映) でビューアがマウントし直されたときは、
  // ページ・ズーム・回転・表示モード・サイドバーを引き継ぐ。文書と注釈は読み直す
  initTab: (tabId) =>
    set((s) => {
      const prev = s.tabs[tabId];
      const next = defaultTabState();
      return {
        tabs: {
          ...s.tabs,
          [tabId]: prev
            ? {
                ...next,
                currentPage: prev.currentPage,
                zoom: prev.zoom,
                rotation: prev.rotation,
                displayMode: prev.displayMode,
                isSidebarOpen: prev.isSidebarOpen,
                sidebarMode: prev.sidebarMode,
                highlightColor: prev.highlightColor,
              }
            : next,
        },
      };
    }),

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

  addAnnotation: (tabId, annotation) =>
    set((s) => {
      const tab = s.tabs[tabId];
      if (!tab) return s;
      const pageAnns = tab.annotations[annotation.pageIndex] ?? [];
      return patch(s, tabId, {
        annotations: {
          ...tab.annotations,
          [annotation.pageIndex]: [...pageAnns, annotation],
        },
      });
    }),

  deleteAnnotation: (tabId, pageIndex, annotationId) =>
    set((s) => {
      const tab = s.tabs[tabId];
      if (!tab) return s;
      const pageAnns = (tab.annotations[pageIndex] ?? []).filter(
        (a) => a.id !== annotationId
      );
      return patch(s, tabId, {
        annotations: { ...tab.annotations, [pageIndex]: pageAnns },
        selectedAnnotationId:
          tab.selectedAnnotationId === annotationId
            ? null
            : tab.selectedAnnotationId,
      });
    }),

  setAnnotations: (tabId, annotations) =>
    set((s) => {
      const byPage: Record<number, Annotation[]> = {};
      for (const ann of annotations) {
        if (!byPage[ann.pageIndex]) byPage[ann.pageIndex] = [];
        byPage[ann.pageIndex].push(ann);
      }
      return patch(s, tabId, { annotations: byPage });
    }),

  setAnnotationMode: (tabId, annotationMode) =>
    set((s) => patch(s, tabId, { annotationMode })),

  setSelectedAnnotationId: (tabId, selectedAnnotationId) =>
    set((s) => patch(s, tabId, { selectedAnnotationId })),

  setHighlightColor: (tabId, highlightColor) =>
    set((s) => patch(s, tabId, { highlightColor })),
}));
