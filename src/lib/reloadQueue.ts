export interface PendingReload {
  tabId: string;
  filePath: string;
}

/** 変更通知を順番待ちに追加する。同じタブの通知は 1 件にまとめる。 */
export function enqueueReload(queue: PendingReload[], item: PendingReload): PendingReload[] {
  return queue.some((q) => q.tabId === item.tabId) ? queue : [...queue, item];
}

/** まだ開いているタブの通知のうち最初の 1 件 (閉じたタブの通知は飛ばす) */
export function nextReload(queue: PendingReload[], openTabIds: string[]): PendingReload | null {
  return queue.find((q) => openTabIds.includes(q.tabId)) ?? null;
}
