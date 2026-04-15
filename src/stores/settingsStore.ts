import { create } from "zustand";

export type Theme = "system" | "light" | "dark";

interface SettingsState {
  theme: Theme;
  zoomLevel: number;
  setTheme: (theme: Theme) => void;
  setZoomLevel: (level: number) => void;
  increaseZoom: () => void;
  decreaseZoom: () => void;
  resetZoom: () => void;
}

const ZOOM_MIN = 10;
const ZOOM_MAX = 32;
const ZOOM_STEP = 2;
const ZOOM_DEFAULT = 14;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "system",
  zoomLevel: ZOOM_DEFAULT,

  setTheme: (theme) => set({ theme }),

  setZoomLevel: (level) =>
    set({ zoomLevel: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level)) }),

  increaseZoom: () => {
    const { zoomLevel } = get();
    set({ zoomLevel: Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP) });
  },

  decreaseZoom: () => {
    const { zoomLevel } = get();
    set({ zoomLevel: Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP) });
  },

  resetZoom: () => set({ zoomLevel: ZOOM_DEFAULT }),
}));
