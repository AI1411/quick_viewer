import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { FileInfo } from "../types";

/** Rust の open_file コマンドを呼び出してファイル情報を返す */
export async function openFile(path: string): Promise<FileInfo> {
  return invoke<FileInfo>("open_file", { path });
}

/**
 * ネイティブファイル選択ダイアログを開く。
 * ユーザーがキャンセルした場合は null を返す。
 */
export async function showOpenDialog(): Promise<string | null> {
  const result = await openDialog({
    multiple: false,
    filters: [
      {
        name: "Supported Files",
        extensions: ["csv", "tsv", "pdf", "md", "markdown", "xlsx"],
      },
    ],
  });
  // result は string | string[] | null
  if (result === null) return null;
  return Array.isArray(result) ? result[0] : result;
}
