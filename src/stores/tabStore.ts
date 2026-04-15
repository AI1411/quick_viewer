import { create } from "zustand";

interface Tab {
  id: string;
  title: string;
  filePath: string;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
}

export const useTabStore = create<TabState>((set) => ({
  tabs: [],
  activeTabId: null,
  addTab: (tab) => set((state) => ({ tabs: [...state.tabs, tab] })),
  removeTab: (id) =>
    set((state) => ({
      tabs: state.tabs.filter((t) => t.id !== id),
      activeTabId: state.activeTabId === id ? null : state.activeTabId,
    })),
  setActiveTab: (id) => set({ activeTabId: id }),
}));
