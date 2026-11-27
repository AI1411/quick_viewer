import { invoke } from "@tauri-apps/api/core";
import type { MarkdownResult } from "../types";
import { markSelfWrite } from "./selfWriteGuard";

export async function readMarkdown(path: string): Promise<MarkdownResult> {
  return invoke<MarkdownResult>("read_markdown", { path });
}

export async function saveMarkdown(
  path: string,
  content: string,
  encoding?: string
): Promise<void> {
  markSelfWrite(path);
  return invoke<void>("save_markdown", { path, content, encoding: encoding ?? null });
}

export async function renderMarkdownString(content: string): Promise<MarkdownResult> {
  return invoke<MarkdownResult>("render_markdown_string", { content });
}
