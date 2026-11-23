import { create } from "zustand";
import type { FileFormat } from "../types";
import { cleanupTabStores } from "../lib/cleanupTabStores";

export interface Tab {
  id: string;
  title: string;
  filePath: string;
  format?: FileFormat;
  isDirty: boolean;
  reloadCount: number;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  reorderTabs: (dragId: string, toIndex: number) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  setDirty: (id: string, isDirty: boolean) => void;
  bumpReload: (id: string) => void;
}

export const useTabStore = create<TabState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (tab) => set((state) => ({ tabs: [...state.tabs, tab] })),

  removeTab: (id) => {
    cleanupTabStores(id);
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      const newTabs = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;
      if (state.activeTabId === id) {
        if (newTabs.length === 0) {
          newActiveId = null;
        } else {
          // 左隣を優先、なければ右隣
          newActiveId = newTabs[Math.max(0, idx - 1)].id;
        }
      }
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  reorderTabs: (dragId, toIndex) =>
    set((state) => {
      const fromIndex = state.tabs.findIndex((t) => t.id === dragId);
      if (fromIndex === -1) return {};
      const newTabs = [...state.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);
      return { tabs: newTabs };
    }),

  closeOtherTabs: (id) => {
    const { tabs } = get();
    for (const tab of tabs) {
      if (tab.id !== id) cleanupTabStores(tab.id);
    }
    set({
      tabs: tabs.filter((t) => t.id === id),
      activeTabId: id,
    });
  },

  closeTabsToRight: (id) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const toClose = tabs.slice(idx + 1);
    for (const tab of toClose) cleanupTabStores(tab.id);
    const newTabs = tabs.slice(0, idx + 1);
    const stillActive =
      activeTabId != null && newTabs.some((t) => t.id === activeTabId);
    set({
      tabs: newTabs,
      activeTabId: stillActive ? activeTabId : id,
    });
  },

  setDirty: (id, isDirty) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, isDirty } : t)),
    })),

  bumpReload: (id) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, reloadCount: t.reloadCount + 1 } : t
      ),
    })),
}));
