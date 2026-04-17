import { useEffect, useRef, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { dirname, join } from "@tauri-apps/api/path";
import { createHighlighter, type Highlighter } from "shiki";
import mermaid from "mermaid";
import "katex/dist/katex.min.css";

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

mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

function isDarkTheme(): boolean {
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

interface RenderedViewProps {
  html: string;
  filePath: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
}

export function RenderedView({ html, filePath, containerRef, onScroll }: RenderedViewProps) {
  const innerRef = useRef<HTMLDivElement>(null);

  const postProcess = useCallback(async () => {
    const el = innerRef.current;
    if (!el) return;

    // 1. Mermaid（先に処理してコードブロックをSVGに置換）
    const mermaidEls = el.querySelectorAll<HTMLElement>("code.language-mermaid");
    await Promise.all(
      Array.from(mermaidEls).map(async (codeEl, i) => {
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
  }, [html, filePath]);

  useEffect(() => {
    postProcess();
  }, [postProcess]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto"
      style={{ backgroundColor: "var(--viewer-bg)" }}
      onScroll={() => onScroll?.()}
    >
      <div
        ref={innerRef}
        className="markdown-body max-w-4xl mx-auto px-8 py-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
