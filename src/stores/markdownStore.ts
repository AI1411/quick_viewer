import { create } from "zustand";
import type { MarkdownResult, ViewMode } from "../types";

interface MarkdownTabState {
  data: MarkdownResult | null;
  isLoading: boolean;
  error: string | null;
  viewMode: ViewMode;
  editContent: string | null;
  isDirty: boolean;
}

interface MarkdownStore {
  tabs: Record<string, MarkdownTabState>;
  initTab: (tabId: string) => void;
  setData: (tabId: string, data: MarkdownResult) => void;
  setLoading: (tabId: string, isLoading: boolean) => void;
  setError: (tabId: string, error: string | null) => void;
  removeTab: (tabId: string) => void;
  setViewMode: (tabId: string, mode: ViewMode) => void;
  setEditContent: (tabId: string, content: string) => void;
  setDirty: (tabId: string, isDirty: boolean) => void;
  discardEdits: (tabId: string) => void;
}

export const useMarkdownStore = create<MarkdownStore>((set) => ({
  tabs: {},

  initTab: (tabId) =>
    set((s) => ({
      tabs: {
        ...s.tabs,
        [tabId]:
          s.tabs[tabId] ??
          {
            data: null,
            isLoading: false,
            error: null,
            viewMode: "preview",
            editContent: null,
            isDirty: false,
          },
      },
    })),

  setData: (tabId, data) =>
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], data } },
    })),

  setLoading: (tabId, isLoading) =>
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], isLoading } },
    })),

  setError: (tabId, error) =>
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], error } },
    })),

  removeTab: (tabId) =>
    set((s) => {
      const tabs = { ...s.tabs };
      delete tabs[tabId];
      return { tabs };
    }),

  setViewMode: (tabId, viewMode) =>
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], viewMode } },
    })),

  setEditContent: (tabId, editContent) =>
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], editContent } },
    })),

  setDirty: (tabId, isDirty) =>
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], isDirty } },
    })),

  discardEdits: (tabId) =>
    set((s) => {
      const tab = s.tabs[tabId];
      if (!tab) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...tab, editContent: null, isDirty: false } } };
    }),
}));
