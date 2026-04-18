import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { showError } from "./toastStore";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "settings";

export interface CsvSettings {
  defaultDelimiter: "auto" | "," | "\t" | ";" | "|";
}

export interface PdfSettings {
  defaultViewMode: "single" | "continuous";
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
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  setZoomLevel: (level) => {
    set({ zoomLevel: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level)) });
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  increaseZoom: () => {
    const { zoomLevel } = get();
    set({ zoomLevel: Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP) });
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  decreaseZoom: () => {
    const { zoomLevel } = get();
    set({ zoomLevel: Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP) });
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  resetZoom: () => {
    set({ zoomLevel: ZOOM_DEFAULT });
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  setFontFamily: (fontFamily) => {
    set({ fontFamily });
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  setCsvSettings: (s) => {
    set((prev) => ({ csvSettings: { ...prev.csvSettings, ...s } }));
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  setPdfSettings: (s) => {
    set((prev) => ({ pdfSettings: { ...prev.pdfSettings, ...s } }));
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  setMarkdownSettings: (s) => {
    set((prev) => ({ markdownSettings: { ...prev.markdownSettings, ...s } }));
    get().saveToDisk().catch(() => showError("設定の保存に失敗しました"));
  },

  loadFromDisk: async () => {
    try {
      const raw = await invoke<string | null>("load_app_data", { key: STORAGE_KEY });
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.pdfSettings?.defaultViewMode === "double") {
          parsed.pdfSettings.defaultViewMode = "continuous";
        }
        set({ ...DEFAULT_SETTINGS, ...parsed });
      }
    } catch {
      // 初回起動
    }
  },

  saveToDisk: async () => {
    const { theme, zoomLevel, fontFamily, csvSettings, pdfSettings, markdownSettings } = get();
    await invoke("save_app_data", {
      key: STORAGE_KEY,
      value: JSON.stringify({ theme, zoomLevel, fontFamily, csvSettings, pdfSettings, markdownSettings }),
    });
  },
}));
