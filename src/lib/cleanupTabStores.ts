import { useCsvStore } from "../stores/csvStore";
import { useMarkdownStore } from "../stores/markdownStore";
import { usePdfStore } from "../stores/pdfStore";
import { useXlsxStore } from "../stores/xlsxStore";

/** Free per-format viewer store state when a tab is closed. */
export function cleanupTabStores(tabId: string): void {
  useCsvStore.getState().removeTab(tabId);
  usePdfStore.getState().removeTab(tabId);
  useXlsxStore.getState().removeTab(tabId);
  useMarkdownStore.getState().removeTab(tabId);
}
