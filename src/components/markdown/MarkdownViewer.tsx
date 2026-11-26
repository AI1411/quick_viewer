import { useEffect, useRef, useState } from "react";
import { useMarkdownStore } from "../../stores/markdownStore";
import { useTabStore } from "../../stores/tabStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { readMarkdown, saveMarkdown, renderMarkdownString } from "../../lib/markdownCommands";
import { useShortcuts } from "../../hooks/useShortcuts";
import { showError, showWarning } from "../../stores/toastStore";
import { errorMessage } from "../../lib/errorUtils";
import { RenderedView } from "./RenderedView";
import { TocSidebar } from "./TocSidebar";
import { SourceEditor } from "./SourceEditor";
import { SplitView } from "./SplitView";
import type { ViewMode } from "../../types";

interface MarkdownViewerProps {
  tabId: string;
  filePath: string;
}

export function MarkdownViewer({ tabId, filePath }: MarkdownViewerProps) {
  const { initTab, setData, setLoading, setError, setViewMode, setEditContent, setDirty } =
    useMarkdownStore.getState();
  const { setDirty: setTabDirty } = useTabStore.getState();
  const tab = useMarkdownStore((s) => s.tabs[tabId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [liveHtml, setLiveHtml] = useState<string | null>(null);
  // プレビューの描画要求の通し番号。遅れて返ってきた古い結果で新しい結果を上書きしない
  const previewSeqRef = useRef(0);
  const renderPreview = (content: string) => {
    const seq = ++previewSeqRef.current;
    renderMarkdownString(content)
      .then((result) => {
        if (seq === previewSeqRef.current) setLiveHtml(result.html);
      })
      .catch(() => {}); // preview failure is non-fatal
  };

  useEffect(() => {
    initTab(tabId, useSettingsStore.getState().markdownSettings.defaultView);
    // ストアのエントリはアンマウント後も残るので、前回の読込エラーをここで消す
    setError(tabId, null);
    setLoading(tabId, true);
    readMarkdown(filePath)
      .then((result) => {
        setData(tabId, result);
        // 未保存の編集が無ければ、エディタをディスクの最新内容に合わせる
        if (!useMarkdownStore.getState().tabs[tabId]?.isDirty) {
          useMarkdownStore.getState().discardEdits(tabId);
        }
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

    const timer = setTimeout(() => renderPreview(content), 300);
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
      if (content) renderPreview(content);
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

  // 保存中もエディタを表示したままにする (キャレット位置と undo 履歴を保つ)。
  // 失敗してもエラー画面に切り替えず、編集内容を残したまま通知する。
  useShortcuts({
    "cmd+s": async () => {
      const state = useMarkdownStore.getState().tabs[tabId];
      if (!state?.isDirty || state.editContent === null) return;
      const content = state.editContent;
      try {
        await saveMarkdown(filePath, content, state.data?.encoding);
      } catch (err) {
        showError(`保存に失敗しました: ${errorMessage(err)}`);
        return;
      }
      try {
        const result = await readMarkdown(filePath);
        setData(tabId, result);
      } catch (err) {
        showWarning(`保存しましたが、再読み込みに失敗しました: ${errorMessage(err)}`);
      }
      // 保存中に続けて入力された分は未保存のまま残す
      const latest = useMarkdownStore.getState().tabs[tabId]?.editContent;
      const dirty = latest != null && latest !== content;
      setDirty(tabId, dirty);
      setTabDirty(tabId, dirty);
    },
  });

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
