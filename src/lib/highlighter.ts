import { createHighlighter, createJavaScriptRegexEngine, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * 既定の Oniguruma エンジンは WebAssembly を使うが、CSP (script-src 'self') に
 * 'wasm-unsafe-eval' が無いため webview では読み込めず、ハイライトが黙って失敗する。
 * CSP を緩めずに済むよう JavaScript の正規表現エンジンを使う。
 */
export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    engine: createJavaScriptRegexEngine(),
    themes: ["github-dark", "github-light"],
    langs: [
      "javascript", "typescript", "tsx", "jsx",
      "python", "rust", "go", "java", "c", "cpp",
      "bash", "shell", "json", "yaml", "toml",
      "markdown", "html", "css", "sql",
      "ruby", "php", "swift", "kotlin",
    ],
  });
  return highlighterPromise;
}
