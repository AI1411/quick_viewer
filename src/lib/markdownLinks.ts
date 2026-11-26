import { openUrl } from "@tauri-apps/plugin-opener";
import { openPathInTab } from "./openPathInTab";
import { errorMessage } from "./errorUtils";
import { showError } from "../stores/toastStore";

export type LinkAction =
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string }
  | { kind: "file"; path: string }
  | { kind: "none" };

// opener:default が許可するスキームと一致させる
const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const OPENABLE_FILE = /\.(md|markdown|csv|tsv|pdf|xlsx)$/i;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function resolveRelativePath(markdownPath: string, relative: string): string {
  const sep = markdownPath.includes("\\") && !markdownPath.includes("/") ? "\\" : "/";
  const isAbsolute = relative.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relative);
  const base = isAbsolute ? [] : markdownPath.split(/[\\/]/).slice(0, -1);
  const parts = [...base];
  for (const seg of relative.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const joined = parts.join(sep);
  return relative.startsWith("/") ? `/${joined}` : joined;
}

/** img の src がローカルファイルを指す場合だけ絶対パスを返す (http(s): や data: などは null) */
export function resolveLocalImagePath(src: string, markdownPath: string): string | null {
  const target = src.trim();
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)?.[1];
  if (!target || (scheme && !/^[a-zA-Z]$/.test(scheme))) return null;
  const pathPart = safeDecode(target.split(/[?#]/)[0]);
  return pathPart ? resolveRelativePath(markdownPath, pathPart) : null;
}

export function resolveMarkdownLink(href: string, markdownPath: string): LinkAction {
  const target = href.trim();
  if (target.startsWith("#")) {
    return target.length > 1 ? { kind: "anchor", id: safeDecode(target.slice(1)) } : { kind: "none" };
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)?.[1];
  if (scheme && !/^[a-zA-Z]$/.test(scheme)) {
    return EXTERNAL_SCHEMES.has(scheme.toLowerCase()) ? { kind: "external", url: target } : { kind: "none" };
  }
  const pathPart = safeDecode(target.split(/[?#]/)[0]);
  if (!pathPart || !OPENABLE_FILE.test(pathPart)) return { kind: "none" };
  return { kind: "file", path: resolveRelativePath(markdownPath, pathPart) };
}

/**
 * 描画済み Markdown 内のリンククリックを横取りする。
 * webview 自体を遷移させるとアプリが再読み込みされ全タブが消えるため、
 * 既定動作は常に止め、外部 URL は OS の既定アプリ、対応ファイルは新しいタブで開く。
 */
export function handleRenderedLinkClick(
  e: { target: EventTarget | null; preventDefault(): void },
  container: HTMLElement,
  markdownPath: string
): void {
  const target = e.target as Element | null;
  const link = target?.closest?.("a, area");
  if (!link || !container.contains(link)) return;
  const href = link.getAttribute("href") ?? link.getAttribute("xlink:href");
  e.preventDefault();
  if (!href) return;

  const action = resolveMarkdownLink(href, markdownPath);
  switch (action.kind) {
    case "anchor": {
      const el =
        container.querySelector(`[id="${CSS.escape(action.id)}"]`) ??
        container.querySelector(`[name="${CSS.escape(action.id)}"]`);
      el?.scrollIntoView({ block: "start" });
      break;
    }
    case "external":
      openUrl(action.url).catch((err: unknown) => {
        showError(`リンクを開けませんでした: ${errorMessage(err)}`);
      });
      break;
    case "file":
      void openPathInTab(action.path);
      break;
    case "none":
      break;
  }
}
