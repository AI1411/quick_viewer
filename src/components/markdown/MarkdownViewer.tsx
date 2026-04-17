import { useEffect, useRef, useState } from "react";
import { useMarkdownStore } from "../../stores/markdownStore";
import { readMarkdown } from "../../lib/markdownCommands";
import { RenderedView } from "./RenderedView";
import { TocSidebar } from "./TocSidebar";

interface MarkdownViewerProps {
  tabId: string;
  filePath: string;
}

export function MarkdownViewer({ tabId, filePath }: MarkdownViewerProps) {
  const { initTab, setData, setLoading, setError } = useMarkdownStore.getState();
  const tab = useMarkdownStore((s) => s.tabs[tabId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);

  useEffect(() => {
    initTab(tabId);
    // 既にデータかエラーがある場合は再読み込みしない
    const current = useMarkdownStore.getState().tabs[tabId];
    if (current?.data != null || current?.error != null) return;

    setLoading(tabId, true);
    readMarkdown(filePath)
      .then((result) => {
        setData(tabId, result);
        setLoading(tabId, false);
      })
      .catch((err: unknown) => {
        setError(tabId, String(err));
        setLoading(tabId, false);
      });
  }, [tabId, filePath]);

  function handleScroll() {
    if (!tab?.data?.toc || !containerRef.current) return;
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();

    let active = tab.data.toc[0]?.anchor ?? null;
    for (const item of tab.data.toc) {
      const el = container.querySelector<HTMLElement>(`#${CSS.escape(item.anchor)}`);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top - containerRect.top <= 80) {
          active = item.anchor;
        }
      }
    }
    setActiveAnchor(active);
  }

  if (!tab || tab.isLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "var(--text-secondary)", backgroundColor: "var(--viewer-bg)" }}
      >
        読み込み中...
      </div>
    );
  }

  if (tab.error) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "#f85149", backgroundColor: "var(--viewer-bg)" }}
      >
        エラー: {tab.error}
      </div>
    );
  }

  if (!tab.data) return null;

  return (
    <div className="flex-1 flex overflow-hidden" style={{ backgroundColor: "var(--viewer-bg)" }}>
      <TocSidebar
        toc={tab.data.toc}
        activeAnchor={activeAnchor}
        containerRef={containerRef}
      />
      <RenderedView
        html={tab.data.html}
        filePath={filePath}
        containerRef={containerRef}
        onScroll={() => handleScroll()}
      />
    </div>
  );
}
