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

interface PersistedSettings {
  theme: Theme;
  zoomLevel: number;
  fontFamily: string;
  csvSettings: CsvSettings;
  pdfSettings: PdfSettings;
  markdownSettings: MarkdownSettings;
}

const DEFAULT_SETTINGS: PersistedSettings = {
  theme: "system",
  zoomLevel: ZOOM_DEFAULT,
  fontFamily: "system-ui",
  csvSettings: { defaultDelimiter: "auto" },
  pdfSettings: { defaultViewMode: "continuous" },
  markdownSettings: { defaultView: "preview" },
};

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * 保存された設定を項目ごとに検査し、不正な値は既定値に置き換える。
 * 以前は丸ごとストアにマージしていたため、壊れたファイルで型の違う値や
 * アクション名と同じキーが入り込むと、起動時や操作時に落ちる恐れがあった。
 */
export function parseSettings(value: unknown): PersistedSettings {
  const s = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const sub = (v: unknown) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
  const zoom = typeof s.zoomLevel === "number" && Number.isFinite(s.zoomLevel) ? s.zoomLevel : ZOOM_DEFAULT;
  const viewMode = sub(s.pdfSettings).defaultViewMode;
  return {
    theme: oneOf<Theme>(s.theme, ["system", "light", "dark"], DEFAULT_SETTINGS.theme),
    zoomLevel: Math.max(ZOOM_MIN, Math.min(zoom, ZOOM_MAX)),
    fontFamily:
      typeof s.fontFamily === "string" && s.fontFamily.length <= 200 ? s.fontFamily : DEFAULT_SETTINGS.fontFamily,
    csvSettings: {
      defaultDelimiter: oneOf(
        sub(s.csvSettings).defaultDelimiter,
        ["auto", ",", "\t", ";", "|"] as const,
        DEFAULT_SETTINGS.csvSettings.defaultDelimiter
      ),
    },
    pdfSettings: {
      // 旧バージョンの "double" は "continuous" に読み替える
      defaultViewMode: oneOf(
        viewMode === "double" ? "continuous" : viewMode,
        ["single", "continuous"] as const,
        DEFAULT_SETTINGS.pdfSettings.defaultViewMode
      ),
    },
    markdownSettings: {
      defaultView: oneOf(
        sub(s.markdownSettings).defaultView,
        ["preview", "source", "split"] as const,
        DEFAULT_SETTINGS.markdownSettings.defaultView
      ),
    },
  };
}

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
        if (raw.length > 1 * 1024 * 1024) {
          console.warn("settings.json が大きすぎるためデフォルト設定を使用");
          return;
        }
        set(parseSettings(JSON.parse(raw)));
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
