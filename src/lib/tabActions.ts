import { useTabStore } from "../stores/tabStore";
import { useMarkdownStore } from "../stores/markdownStore";

/** 外部変更の「再読み込み」。未保存の編集はディスクの内容で置き換える。 */
export function reloadTabFromDisk(tabId: string): void {
  useMarkdownStore.getState().discardEdits(tabId);
  useTabStore.getState().setDirty(tabId, false);
  useTabStore.getState().bumpReload(tabId);
}
