import { create } from "zustand";
import type { MarkdownResult } from "../types";

interface MarkdownTabState {
  data: MarkdownResult | null;
  isLoading: boolean;
  error: string | null;
}

interface MarkdownStore {
  tabs: Record<string, MarkdownTabState>;
  initTab: (tabId: string) => void;
  setData: (tabId: string, data: MarkdownResult) => void;
  setLoading: (tabId: string, isLoading: boolean) => void;
  setError: (tabId: string, error: string | null) => void;
  removeTab: (tabId: string) => void;
}

export const useMarkdownStore = create<MarkdownStore>((set) => ({
  tabs: {},

  initTab: (tabId) =>
    set((s) => ({
      tabs: {
        ...s.tabs,
        [tabId]: s.tabs[tabId] ?? { data: null, isLoading: false, error: null },
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
      const { [tabId]: _, ...rest } = s.tabs;
      return { tabs: rest };
    }),
}));
