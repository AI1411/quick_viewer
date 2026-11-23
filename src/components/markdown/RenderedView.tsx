import { useEffect, useRef, useCallback, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { dirname, join } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createHighlighter, type Highlighter } from "shiki";
import mermaid from "mermaid";
import "katex/dist/katex.min.css";
import { openFile } from "../../lib/fileCommands";
import { useSearchStore } from "../../stores/searchStore";
import { useTabStore, useRecentFilesStore, showError } from "../../stores";
import type { RecentFile } from "../../stores";
import { highlightTextNodes, clearSearchMarks, applyMarkStyles } from "../../lib/searchHighlight";
import { errorMessage } from "../../lib/errorUtils";

let _highlighter: Highlighter | null = null;
let _highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (_highlighter) return _highlighter;
  if (!_highlighterPromise) {
    _highlighterPromise = createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: [
        "javascript", "typescript", "tsx", "jsx",
        "python", "rust", "go", "java", "c", "cpp",
        "bash", "shell", "json", "yaml", "toml",
        "markdown", "html", "css", "sql",
        "ruby", "php", "swift", "kotlin",
      ],
    }).then((h) => { _highlighter = h; return h; });
  }
  return _highlighterPromise;
}

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

function isDarkTheme(): boolean {
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

async function openMarkdownInNewTab(path: string): Promise<void> {
  try {
    const info = await openFile(path);
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { addTab, setActiveTab } = useTabStore.getState();
    addTab({
      id,
      title: info.name,
      filePath: info.path,
      format: info.format,
      isDirty: false,
      reloadCount: 0,
    });
    setActiveTab(id);
    useRecentFilesStore.getState().addRecentFile({
      path: info.path,
      name: info.name,
      format: info.format as RecentFile["format"],
      openedAt: new Date().toISOString(),
    });
  } catch (err) {
    showError(`ファイルを開けませんでした: ${errorMessage(err)}`);
  }
}

/** Exported for tests: classify markdown link hrefs. */
export function classifyMarkdownHref(href: string): {
  kind: "anchor" | "external" | "markdown" | "other";
  value: string;
} {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) {
    return { kind: "anchor", value: trimmed.slice(1) };
  }
  if (
    /^https?:/i.test(trimmed) ||
    /^mailto:/i.test(trimmed)
  ) {
    return { kind: "external", value: trimmed };
  }
  // Strip hash/query for extension check
  const pathOnly = trimmed.split(/[?#]/)[0] ?? trimmed;
  if (/\.(md|markdown)$/i.test(pathOnly) && !/^[a-z][a-z0-9+.-]*:/i.test(pathOnly)) {
    return { kind: "markdown", value: trimmed };
  }
  return { kind: "other", value: trimmed };
}

interface RenderedViewProps {
  html: string;
  filePath: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
}

export function RenderedView({ html, filePath, containerRef, onScroll }: RenderedViewProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [postProcessKey, setPostProcessKey] = useState(0);
  const searchMarksRef = useRef<HTMLElement[]>([]);

  const postProcess = useCallback(async () => {
    const el = innerRef.current;
    if (!el) return;

    // ブロック数・文字数の制限
    const MERMAID_MAX_BLOCKS = 20;
    const CODE_MAX_CHARS = 500_000;
    const MATH_MAX_CHARS = 200_000;

    // 1. Mermaid（先に処理してコードブロックをSVGに置換）
    const mermaidEls = Array.from(
      el.querySelectorAll<HTMLElement>("code.language-mermaid")
    ).slice(0, MERMAID_MAX_BLOCKS);
    await Promise.all(
      mermaidEls.map(async (codeEl, i) => {
        const pre = codeEl.parentElement;
        if (!pre) return;
        const code = codeEl.textContent ?? "";
        const id = `mermaid-${Date.now()}-${i}`;
        try {
          const { svg } = await mermaid.render(id, code);
          const div = document.createElement("div");
          div.className = "mermaid-diagram";
          div.style.overflowX = "auto";
          div.innerHTML = svg;
          pre.replaceWith(div);
        } catch {
          // Mermaid パースエラーは無視してコードブロックのまま表示
        }
      })
    );

    // 2. Shiki シンタックスハイライト
    try {
      const highlighter = await getHighlighter();
      const theme = isDarkTheme() ? "github-dark" : "github-light";
      const loadedLangs = highlighter.getLoadedLanguages();

      for (const codeEl of Array.from(
        el.querySelectorAll<HTMLElement>("pre > code[class]")
      )) {
        const match = codeEl.className.match(/language-(\w+)/);
        if (!match) continue;
        const lang = match[1];
        const code = codeEl.textContent ?? "";
        if (code.length > CODE_MAX_CHARS) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const safeLang = loadedLangs.includes(lang as any) ? (lang as any) : "text";
        const highlighted = highlighter.codeToHtml(code, { lang: safeLang, theme });
        const wrapper = document.createElement("div");
        wrapper.innerHTML = highlighted;
        const shikiPre = wrapper.firstElementChild as HTMLElement | null;
        if (shikiPre && codeEl.parentElement) {
          shikiPre.style.borderRadius = "6px";
          shikiPre.style.margin = "0.75rem 0";
          shikiPre.style.padding = "1rem";
          shikiPre.style.overflowX = "auto";
          shikiPre.style.fontSize = "0.875em";
          codeEl.parentElement.replaceWith(shikiPre);
        }
      }
    } catch {
      // Shiki 失敗は無視
    }

    // 3. KaTeX 数式レンダリング
    try {
      if ((el.textContent?.length ?? 0) > MATH_MAX_CHARS) {
        // 数式が多すぎる場合はスキップ
      } else {
        const { default: renderMathInElement } = await import("katex/contrib/auto-render");
        renderMathInElement(el, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
            { left: "\\[", right: "\\]", display: true },
          ],
          throwOnError: false,
        });
      }
    } catch {
      // KaTeX 失敗は無視
    }

    // 4. ローカル画像パス解決
    try {
      const dir = await dirname(filePath);
      for (const img of Array.from(el.querySelectorAll<HTMLImageElement>("img"))) {
        const src = img.getAttribute("src");
        if (
          src &&
          !src.startsWith("http") &&
          !src.startsWith("data:") &&
          !src.startsWith("asset:")
        ) {
          const abs = await join(dir, src);
          img.src = convertFileSrc(abs);
        }
      }
    } catch {
      // パス解決失敗は無視
    }

    setPostProcessKey((k) => k + 1);
  }, [html, filePath]);

  useEffect(() => {
    postProcess();
  }, [postProcess]);

  const handleClick = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!target) return;

      const href = target.getAttribute("href");
      if (!href) return;

      // Always stop WebView navigation so custom title bar can't strand the user
      e.preventDefault();
      e.stopPropagation();

      const classified = classifyMarkdownHref(href);
      const container = containerRef.current;

      if (classified.kind === "anchor") {
        if (!container || !classified.value) return;
        const el = container.querySelector<HTMLElement>(
          `#${CSS.escape(classified.value)}`
        );
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (classified.kind === "external") {
        try {
          await openUrl(classified.value);
        } catch (err) {
          showError(`リンクを開けませんでした: ${errorMessage(err)}`);
        }
        return;
      }

      if (classified.kind === "markdown") {
        try {
          const pathOnly = classified.value.split(/[?#]/)[0] ?? classified.value;
          const dir = await dirname(filePath);
          const abs = await join(dir, pathOnly);
          await openMarkdownInNewTab(abs);
        } catch (err) {
          showError(`Markdown を開けませんでした: ${errorMessage(err)}`);
        }
      }
    },
    [containerRef, filePath]
  );

  // 検索ハイライト（postProcess 完了後に適用）
  const searchIsOpen = useSearchStore((s) => s.isOpen);
  const searchQuery = useSearchStore((s) => s.isOpen ? s.query : "");
  const searchUseRegex = useSearchStore((s) => s.options.useRegex);
  const searchCaseSensitive = useSearchStore((s) => s.options.caseSensitive);
  const currentMatchIndex = useSearchStore((s) => s.currentMatchIndex);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    clearSearchMarks(el);
    searchMarksRef.current = [];

    if (!searchIsOpen || !searchQuery) {
      useSearchStore.getState().setMatchCount(0);
      return;
    }

    const marks = highlightTextNodes(el, searchQuery, {
      useRegex: searchUseRegex,
      caseSensitive: searchCaseSensitive,
    });
    searchMarksRef.current = marks;
    useSearchStore.getState().setMatchCount(marks.length);

    if (marks.length > 0) {
      const idx = currentMatchIndex % marks.length;
      applyMarkStyles(marks, idx);
      marks[idx].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [postProcessKey, searchIsOpen, searchQuery, searchUseRegex, searchCaseSensitive, currentMatchIndex]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto"
      style={{ backgroundColor: "var(--viewer-bg)" }}
      onScroll={() => onScroll?.()}
      onClick={handleClick}
    >
      <div
        ref={innerRef}
        className="markdown-body max-w-4xl mx-auto px-8 py-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
