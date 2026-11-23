import { useEffect, useRef, useState } from "react";
import { useMarkdownStore } from "../../stores/markdownStore";
import { useTabStore } from "../../stores/tabStore";
import { readMarkdown, saveMarkdown, renderMarkdownString } from "../../lib/markdownCommands";
import { useShortcuts } from "../../hooks/useShortcuts";
import { RenderedView } from "./RenderedView";
import { TocSidebar } from "./TocSidebar";
import { SourceEditor } from "./SourceEditor";
import { SplitView } from "./SplitView";
import type { ViewMode } from "../../types";

interface MarkdownViewerProps {
  tabId: string;
  filePath: string;
  isActive?: boolean;
}

export function MarkdownViewer({ tabId, filePath, isActive = true }: MarkdownViewerProps) {
  const { initTab, setData, setLoading, setError, setViewMode, setEditContent, setDirty } =
    useMarkdownStore.getState();
  const { setDirty: setTabDirty } = useTabStore.getState();
  const tab = useMarkdownStore((s) => s.tabs[tabId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [liveHtml, setLiveHtml] = useState<string | null>(null);

  useEffect(() => {
    initTab(tabId);
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

  // split モード時: editContent が変わるたびデバウンス 300ms でライブプレビュー更新
  useEffect(() => {
    const viewMode = useMarkdownStore.getState().tabs[tabId]?.viewMode ?? "preview";
    if (viewMode !== "split") return;
    const content = tab?.editContent ?? tab?.data?.raw;
    if (content == null) return;

    const timer = setTimeout(() => {
      renderMarkdownString(content)
        .then((result) => setLiveHtml(result.html))
        .catch(() => {}); // preview failure is non-fatal
    }, 300);
    return () => clearTimeout(timer);
  }, [tab?.editContent, tab?.viewMode, tabId]);

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

  function handleViewModeChange(mode: ViewMode) {
    const state = useMarkdownStore.getState().tabs[tabId];
    if (mode !== "preview" && state?.editContent === null && state?.data) {
      setEditContent(tabId, state.data.raw);
    }
    // split に切り替わったらすぐ初期 liveHtml を設定
    if (mode === "split") {
      const content = state?.editContent ?? state?.data?.raw;
      if (content) {
        renderMarkdownString(content)
          .then((result) => setLiveHtml(result.html))
          .catch(() => {});
      }
    }
    setViewMode(tabId, mode);
  }

  function handleContentChange(content: string) {
    setEditContent(tabId, content);
    const raw = useMarkdownStore.getState().tabs[tabId]?.data?.raw ?? null;
    const dirty = raw !== null && content !== raw;
    setDirty(tabId, dirty);
    setTabDirty(tabId, dirty);
  }

  useShortcuts(
    {
      "cmd+s": () => {
        const state = useMarkdownStore.getState().tabs[tabId];
        if (!state?.isDirty || state.editContent === null) return;
        setLoading(tabId, true);
        saveMarkdown(filePath, state.editContent)
          .then(() => readMarkdown(filePath))
          .then((result) => {
            setData(tabId, result);
            setDirty(tabId, false);
            setTabDirty(tabId, false);
          })
          .catch((err: unknown) => {
            setError(tabId, String(err));
          })
          .finally(() => {
            setLoading(tabId, false);
          });
      },
    },
    isActive
  );

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

  const viewMode = tab.viewMode ?? "preview";
  const editValue = tab.editContent ?? tab.data.raw;

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ backgroundColor: "var(--viewer-bg)" }}
    >
      {/* ビューモードツールバー */}
      <div
        className="flex items-center justify-between px-3 py-1 shrink-0 border-b"
        style={{ borderColor: "var(--border-color)", backgroundColor: "var(--toolbar-bg)" }}
      >
        <div className="flex gap-1">
          {(["preview", "split", "source"] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => handleViewModeChange(mode)}
              className={[
                "px-3 py-0.5 text-xs rounded transition-opacity",
                viewMode === mode
                  ? "opacity-100 font-medium"
                  : "opacity-60 hover:opacity-100",
              ].join(" ")}
              style={{ color: "var(--text-primary)" }}
            >
              {mode === "preview" ? "プレビュー" : mode === "source" ? "ソース" : "分割"}
            </button>
          ))}
        </div>
        {tab.isDirty && (
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
            未保存
          </span>
        )}
      </div>

      {/* メインコンテンツ */}
      <div className="flex flex-1 overflow-hidden">
        {viewMode === "preview" && (
          <>
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
          </>
        )}

        {viewMode === "source" && (
          <SourceEditor content={editValue} onChange={handleContentChange} />
        )}

        {viewMode === "split" && (
          <SplitView
            content={editValue}
            html={liveHtml ?? tab.data.html}
            filePath={filePath}
            onChange={handleContentChange}
          />
        )}
      </div>
    </div>
  );
}
