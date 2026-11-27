import { ask } from "@tauri-apps/plugin-dialog";

/**
 * 未保存の変更があるタブを閉じる前の確認ダイアログ。
 * Yes で true、No / キャンセルで false。
 */
export async function confirmUnsaved(title: string): Promise<boolean> {
  return ask(`「${title}」には未保存の変更があります。閉じますか？`, {
    title: "未保存の変更",
    kind: "warning",
  });
}

/**
 * 複数タブを閉じる前の確認。dirty がなければ true。
 * 1件なら単一タブ用メッセージ、複数なら件数メッセージ。
 */
export async function confirmCloseDirtyTabs(
  dirtyTitles: string[]
): Promise<boolean> {
  if (dirtyTitles.length === 0) return true;
  if (dirtyTitles.length === 1) return confirmUnsaved(dirtyTitles[0]);
  return ask(
    `未保存の変更があるタブが ${dirtyTitles.length} 件あります。閉じますか？`,
    {
      title: "未保存の変更",
      kind: "warning",
    }
  );
}
