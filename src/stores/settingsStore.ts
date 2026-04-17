import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "settings";

export interface CsvSettings {
  defaultDelimiter: "auto" | "," | "\t" | ";" | "|";
}

export interface PdfSettings {
  defaultViewMode: "single" | "double" | "continuous";
}

export interface MarkdownSettings {
  defaultView: "preview" | "source" | "split";
}

interface SettingsState {
  theme: Theme;
  zoomLevel: number;
  fontFamily: string;
  csvSettings: CsvSettings;
  pdfSettings: PdfSettings;
  markdownSettings: MarkdownSettings;
  setTheme: (theme: Theme) => void;
  setZoomLevel: (level: number) => void;
  increaseZoom: () => void;
  decreaseZoom: () => void;
  resetZoom: () => void;
  setFontFamily: (fontFamily: string) => void;
  setCsvSettings: (s: Partial<CsvSettings>) => void;
  setPdfSettings: (s: Partial<PdfSettings>) => void;
  setMarkdownSettings: (s: Partial<MarkdownSettings>) => void;
  loadFromDisk: () => Promise<void>;
  saveToDisk: () => Promise<void>;
}

const ZOOM_MIN = 10;
const ZOOM_MAX = 32;
const ZOOM_STEP = 2;
const ZOOM_DEFAULT = 14;

const DEFAULT_SETTINGS = {
  theme: "system" as Theme,
  zoomLevel: ZOOM_DEFAULT,
  fontFamily: "system-ui",
  csvSettings: { defaultDelimiter: "auto" as const },
  pdfSettings: { defaultViewMode: "continuous" as const },
  markdownSettings: { defaultView: "preview" as const },
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,

  setTheme: (theme) => {
    set({ theme });
    get().saveToDisk();
  },

  setZoomLevel: (level) => {
    set({ zoomLevel: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level)) });
    get().saveToDisk();
  },

  increaseZoom: () => {
    const { zoomLevel } = get();
    set({ zoomLevel: Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP) });
    get().saveToDisk();
  },

  decreaseZoom: () => {
    const { zoomLevel } = get();
    set({ zoomLevel: Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP) });
    get().saveToDisk();
  },

  resetZoom: () => {
    set({ zoomLevel: ZOOM_DEFAULT });
    get().saveToDisk();
  },

  setFontFamily: (fontFamily) => {
    set({ fontFamily });
    get().saveToDisk();
  },

  setCsvSettings: (s) => {
    set((prev) => ({ csvSettings: { ...prev.csvSettings, ...s } }));
    get().saveToDisk();
  },

  setPdfSettings: (s) => {
    set((prev) => ({ pdfSettings: { ...prev.pdfSettings, ...s } }));
    get().saveToDisk();
  },

  setMarkdownSettings: (s) => {
    set((prev) => ({ markdownSettings: { ...prev.markdownSettings, ...s } }));
    get().saveToDisk();
  },

  loadFromDisk: async () => {
    try {
      const raw = await invoke<string | null>("load_app_data", { key: STORAGE_KEY });
      if (raw) {
        const parsed = JSON.parse(raw);
        set({ ...DEFAULT_SETTINGS, ...parsed });
      }
    } catch {
      // 初回起動
    }
  },

  saveToDisk: async () => {
    try {
      const { theme, zoomLevel, fontFamily, csvSettings, pdfSettings, markdownSettings } = get();
      await invoke("save_app_data", {
        key: STORAGE_KEY,
        value: JSON.stringify({ theme, zoomLevel, fontFamily, csvSettings, pdfSettings, markdownSettings }),
      });
    } catch {
      // サイレント失敗
    }
  },
}));
