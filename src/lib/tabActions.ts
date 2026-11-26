import { confirm } from "@tauri-apps/plugin-dialog";
import { useTabStore, type Tab } from "../stores/tabStore";
import { useMarkdownStore } from "../stores/markdownStore";

/** 外部変更の「再読み込み」。未保存の編集はディスクの内容で置き換える。 */
export function reloadTabFromDisk(tabId: string): void {
  useMarkdownStore.getState().discardEdits(tabId);
  useTabStore.getState().setDirty(tabId, false);
  useTabStore.getState().bumpReload(tabId);
}

/**
 * 未保存のタブがあれば破棄してよいか確認する。
 * window.confirm は dialog プラグインが Promise を返す関数に差し替えるため使えない。
 * ダイアログ自体が開けなかった場合は、編集を失わない側 (false) に倒す。
 */
export async function confirmDiscardUnsaved(tabs: Tab[]): Promise<boolean> {
  const dirty = tabs.filter((t) => t.isDirty);
  if (dirty.length === 0) return true;
  const names = dirty.map((t) => `「${t.title}」`).join("、");
  try {
    return await confirm(`${names} には未保存の変更があります。破棄して閉じますか？`, {
      title: "未保存の変更",
      kind: "warning",
      okLabel: "破棄して閉じる",
      cancelLabel: "キャンセル",
    });
  } catch {
    return false;
  }
}

async function closeTabsWithConfirm(select: (tabs: Tab[]) => Tab[]): Promise<boolean> {
  const targets = select(useTabStore.getState().tabs);
  if (targets.length === 0) return true;
  if (!(await confirmDiscardUnsaved(targets))) return false;
  const { removeTab } = useTabStore.getState();
  for (const t of targets) removeTab(t.id);
  return true;
}

export function closeTab(id: string): Promise<boolean> {
  return closeTabsWithConfirm((tabs) => tabs.filter((t) => t.id === id));
}

export async function closeOtherTabs(id: string): Promise<boolean> {
  const closed = await closeTabsWithConfirm((tabs) => tabs.filter((t) => t.id !== id));
  if (closed) useTabStore.getState().setActiveTab(id);
  return closed;
}

export async function closeTabsToRight(id: string): Promise<boolean> {
  const closed = await closeTabsWithConfirm((tabs) => tabs.slice(tabs.findIndex((t) => t.id === id) + 1));
  if (closed && useTabStore.getState().activeTabId === null) useTabStore.getState().setActiveTab(id);
  return closed;
}

/** ウィンドウを閉じる・アプリを終了する前の確認 */
export function confirmCloseAllTabs(): Promise<boolean> {
  return confirmDiscardUnsaved(useTabStore.getState().tabs);
}
