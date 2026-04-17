import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { FileFormat } from "../types";

const MAX_RECENT = 20;
const STORAGE_KEY = "recent_files";

export interface RecentFile {
  path: string;
  name: string;
  format: FileFormat;
  openedAt: string;
}

interface RecentFilesState {
  recentFiles: RecentFile[];
  addRecentFile: (file: RecentFile) => void;
  removeRecentFile: (path: string) => void;
  clearRecentFiles: () => void;
  loadFromDisk: () => Promise<void>;
  saveToDisk: (files: RecentFile[]) => Promise<void>;
}

export const useRecentFilesStore = create<RecentFilesState>((set, get) => ({
  recentFiles: [],

  addRecentFile: (file) => {
    const prev = get().recentFiles.filter((f) => f.path !== file.path);
    const next = [file, ...prev].slice(0, MAX_RECENT);
    set({ recentFiles: next });
    get().saveToDisk(next);
  },

  removeRecentFile: (path) => {
    const next = get().recentFiles.filter((f) => f.path !== path);
    set({ recentFiles: next });
    get().saveToDisk(next);
  },

  clearRecentFiles: () => {
    set({ recentFiles: [] });
    get().saveToDisk([]);
  },

  loadFromDisk: async () => {
    try {
      const raw = await invoke<string | null>("load_app_data", { key: STORAGE_KEY });
      if (raw) {
        const parsed = JSON.parse(raw) as RecentFile[];
        set({ recentFiles: parsed });
      }
    } catch {
      // 初回起動時はファイルなし
    }
  },

  saveToDisk: async (files) => {
    try {
      await invoke("save_app_data", { key: STORAGE_KEY, value: JSON.stringify(files) });
    } catch {
      // サイレント失敗
    }
  },
}));
