import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { FileFormat } from "../types";
import { showError } from "./toastStore";

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
    get().saveToDisk(next).catch(() => showError("最近のファイル一覧の保存に失敗しました"));
  },

  removeRecentFile: (path) => {
    const next = get().recentFiles.filter((f) => f.path !== path);
    set({ recentFiles: next });
    get().saveToDisk(next).catch(() => showError("最近のファイル一覧の保存に失敗しました"));
  },

  clearRecentFiles: () => {
    set({ recentFiles: [] });
    get().saveToDisk([]).catch(() => showError("最近のファイル一覧の保存に失敗しました"));
  },

  loadFromDisk: async () => {
    try {
      const raw = await invoke<string | null>("load_app_data", { key: STORAGE_KEY });
      if (raw) {
        if (raw.length > 5 * 1024 * 1024) {
          console.warn("recent_files.json が大きすぎるためスキップ");
          return;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        const files = (parsed as unknown[])
          .slice(0, MAX_RECENT)
          .filter(
            (f): f is RecentFile =>
              typeof f === "object" && f !== null &&
              typeof (f as RecentFile).path === "string" &&
              typeof (f as RecentFile).name === "string"
          );
        set({ recentFiles: files });
      }
    } catch {
      // 初回起動時はファイルなし
    }
  },

  saveToDisk: async (files) => {
    await invoke("save_app_data", { key: STORAGE_KEY, value: JSON.stringify(files) });
  },
}));
