import { create } from "zustand";
import type { ImageConvertOptions } from "../types";
import { DEFAULT_IMAGE_OPTIONS } from "../lib/imageCommands";

interface ImageStore {
  /** タブごとの変換設定 (タブを切り替えても残す) */
  optionsByTab: Record<string, ImageConvertOptions>;
  /** 最後に使った設定。新しいタブと一括変換の初期値にする */
  lastOptions: ImageConvertOptions;
  /** 一括変換ダイアログで扱うファイル。null なら閉じている */
  batchPaths: string[] | null;
  setOptions: (tabId: string, options: ImageConvertOptions) => void;
  setLastOptions: (options: ImageConvertOptions) => void;
  removeTab: (tabId: string) => void;
  openBatch: (paths: string[]) => void;
  closeBatch: () => void;
}

export const useImageStore = create<ImageStore>((set) => ({
  optionsByTab: {},
  lastOptions: DEFAULT_IMAGE_OPTIONS,
  batchPaths: null,

  setOptions: (tabId, options) =>
    set((s) => ({ optionsByTab: { ...s.optionsByTab, [tabId]: options }, lastOptions: options })),

  setLastOptions: (lastOptions) => set({ lastOptions }),

  removeTab: (tabId) =>
    set((s) => {
      const optionsByTab = { ...s.optionsByTab };
      delete optionsByTab[tabId];
      return { optionsByTab };
    }),

  openBatch: (batchPaths) => set({ batchPaths }),
  closeBatch: () => set({ batchPaths: null }),
}));
