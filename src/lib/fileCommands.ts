import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { FileInfo } from "../types";
import { IMAGE_EXTENSIONS } from "./imageCommands";

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
        extensions: ["csv", "tsv", "pdf", "md", "markdown", "xlsx", ...IMAGE_EXTENSIONS],
      },
    ],
  });
  // result は string | string[] | null
  if (result === null) return null;
  return Array.isArray(result) ? result[0] : result;
}

/** 画像を複数選ぶダイアログ。キャンセルした場合は空配列を返す。 */
export async function showOpenImagesDialog(): Promise<string[]> {
  const result = await openDialog({
    multiple: true,
    filters: [{ name: "画像", extensions: [...IMAGE_EXTENSIONS] }],
  });
  if (result === null) return [];
  return Array.isArray(result) ? result : [result];
}

/** フォルダを選ぶダイアログ。キャンセルした場合は null を返す。 */
export async function showOpenFolderDialog(defaultPath?: string): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false, defaultPath });
  return typeof result === "string" ? result : null;
}
