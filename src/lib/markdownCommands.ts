import { invoke } from "@tauri-apps/api/core";
import type { MarkdownResult } from "../types";

export async function readMarkdown(path: string): Promise<MarkdownResult> {
  return invoke<MarkdownResult>("read_markdown", { path });
}

export async function saveMarkdown(path: string, content: string): Promise<void> {
  return invoke<void>("save_markdown", { path, content });
}
