import { useEffect, useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePdfStore } from "../../stores/pdfStore";
import { useSearchStore } from "../../stores/searchStore";
import { showError } from "../../stores/toastStore";
import { extractPdfInfo, loadPdfDocument } from "../../lib/pdfLib";
import { findPdfMatches, clearPdfTextCache } from "../../lib/pdfTextIndex";
import { PdfCanvas } from "./PdfCanvas";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { OutlineSidebar } from "./OutlineSidebar";
import type { Annotation } from "../../types";
import type { PDFDocumentProxy } from "pdfjs-dist";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;
const ZOOM_STEP = 0.25;

interface PdfViewerProps {
  tabId: string;
  filePath: string;
  isActive?: boolean;
}

// LazyPdfCanvas: only renders when scrolled into view (for continuous mode)
interface LazyPdfCanvasProps {
  pdfDocument: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  rotation: number;
  annotations: Annotation[];
  annotationMode: "none" | "highlight" | "note";
  selectedAnnotationId: string | null;
  onAnnotationCreate: (annotation: Annotation) => void;
  onAnnotationDelete: (pageIndex: number, id: string) => void;
  onAnnotationSelect: (id: string | null) => void;
}

function LazyPdfCanvas({
  pdfDocument,
  pageIndex,
  scale,
  rotation,
  annotations,
  annotationMode,
  selectedAnnotationId,
  onAnnotationCreate,
  onAnnotationDelete,
  onAnnotationSelect,
}: LazyPdfCanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setIsVisible(entries[0].isIntersecting);
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ minHeight: 400 }}>
      {isVisible && (
        <PdfCanvas
          pdfDocument={pdfDocument}
          pageIndex={pageIndex}
          scale={scale}
          rotation={rotation}
          annotations={annotations}
          annotationMode={annotationMode}
          highlightColor="yellow"
          selectedAnnotationId={selectedAnnotationId}
          onAnnotationCreate={onAnnotationCreate}
          onAnnotationDelete={onAnnotationDelete}
          onAnnotationSelect={onAnnotationSelect}
        />
      )}
    </div>
  );
}

export function PdfViewer({ tabId, filePath, isActive = true }: PdfViewerProps) {
  const tabState = usePdfStore((s) => s.tabs[tabId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 初期化 ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let localDoc: PDFDocumentProxy | null = null;
    let cancelled = false;
    const store = usePdfStore.getState();
    store.initTab(tabId);
    store.setLoading(tabId, true);

    Promise.all([
      loadPdfDocument(filePath).then(async (doc) => {
        const info = await extractPdfInfo(doc);
        return { doc, info };
      }),
      invoke<string>("load_annotations", { pdfPath: filePath }).catch(() => "[]"),
    ])
      .then(([{ doc, info }, annsJson]) => {
        if (cancelled) { doc.destroy(); return; }
        localDoc = doc;
        store.setPdfInfo(tabId, info);
        store.setPdfDocument(tabId, doc);
        store.setLoading(tabId, false);
        // 注釈 JSON が巨大（5MB 超）または破損していても無視
        if (annsJson.length < 5 * 1024 * 1024) {
          try {
            const anns: Annotation[] = JSON.parse(annsJson);
            if (Array.isArray(anns) && anns.length > 0) {
              store.setAnnotations(tabId, anns);
            }
          } catch {
            // 注釈ファイルが不正な場合は無視
          }
        }
      })
      .catch((err) => { if (!cancelled) store.setError(tabId, String(err)); });

    return () => {
      cancelled = true;
      if (localDoc) clearPdfTextCache(localDoc);
      localDoc?.destroy();
    };
  }, [tabId, filePath]);

  // ── PDF 全文検索（全ページを getTextContent で索引、キャッシュ付き）────────
  const searchIsOpen = useSearchStore((s) => s.isOpen);
  const searchQuery = useSearchStore((s) => s.query);
  const searchUseRegex = useSearchStore((s) => s.options.useRegex);
  const searchCaseSensitive = useSearchStore((s) => s.options.caseSensitive);
  const currentMatchIndex = useSearchStore((s) => s.currentMatchIndex);
  const pdfMatches = useSearchStore((s) => s.pdfMatches);

  useEffect(() => {
    if (!isActive) return;
    const doc = usePdfStore.getState().tabs[tabId]?.pdfDocument;
    if (!searchIsOpen || !searchQuery || !doc) {
      useSearchStore.getState().setPdfMatches([]);
      return;
    }

    const signal = { cancelled: false };
    findPdfMatches(
      doc,
      searchQuery,
      { useRegex: searchUseRegex, caseSensitive: searchCaseSensitive },
      signal
    ).then((matches) => {
      if (!signal.cancelled) {
        useSearchStore.getState().setPdfMatches(matches);
      }
    });

    return () => {
      signal.cancelled = true;
    };
  }, [
    isActive,
    tabId,
    searchIsOpen,
    searchQuery,
    searchUseRegex,
    searchCaseSensitive,
    tabState?.pdfDocument,
  ]);

  // 次へ／前へ → 該当ページへ移動（連続モードではスクロール）
  useEffect(() => {
    if (!isActive) return;
    if (pdfMatches.length === 0) return;
    const match = pdfMatches[currentMatchIndex];
    if (!match) return;

    const pageNumber = match.pageIndex + 1; // 1-based
    usePdfStore.getState().setCurrentPage(tabId, pageNumber);

    const el = containerRef.current?.querySelector(
      `[data-pdf-page="${match.pageIndex}"]`
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [isActive, tabId, currentMatchIndex, pdfMatches]);

  // ── 注釈の自動保存（デバウンス 500ms）────────────────────────────────────
  useEffect(() => {
    if (!tabState?.annotations) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const allAnnotations = Object.values(tabState.annotations).flat();
      invoke("save_annotations", {
        pdfPath: filePath,
        annotationsJson: JSON.stringify(allAnnotations),
      }).catch((err: unknown) => {
        showError(`注釈の保存に失敗しました: ${String(err)}`);
      });
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [tabState?.annotations, filePath]);

  // ── キーボードナビゲーション（アクティブタブのみ）─────────────────────────
  useEffect(() => {
    if (!isActive) return;

    function handleKey(e: KeyboardEvent) {
      const store = usePdfStore.getState();
      const tab = store.tabs[tabId];
      if (!tab?.pdfInfo) return;
      if (document.activeElement === pageInputRef.current) return;

      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        if (tab.currentPage < tab.pdfInfo.page_count) {
          store.setCurrentPage(tabId, tab.currentPage + 1);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        if (tab.currentPage > 1) {
          store.setCurrentPage(tabId, tab.currentPage - 1);
        }
      } else if (e.key === "Escape") {
        store.setAnnotationMode(tabId, "none");
        store.setSelectedAnnotationId(tabId, null);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isActive, tabId]);

  // ── ズームヘルパー ─────────────────────────────────────────────────────────
  const handleZoomIn = useCallback(() => {
    const tab = usePdfStore.getState().tabs[tabId];
    if (!tab) return;
    usePdfStore.getState().setZoom(tabId, tab.zoom + ZOOM_STEP);
  }, [tabId]);

  const handleZoomOut = useCallback(() => {
    const tab = usePdfStore.getState().tabs[tabId];
    if (!tab) return;
    usePdfStore.getState().setZoom(tabId, tab.zoom - ZOOM_STEP);
  }, [tabId]);

  const handleFitWidth = useCallback(async () => {
    const tab = usePdfStore.getState().tabs[tabId];
    if (!tab?.pdfDocument || !containerRef.current) return;
    const page = await tab.pdfDocument.getPage(tab.currentPage);
    const baseViewport = page.getViewport({ scale: 1.0, rotation: tab.rotation });
    const availableWidth = containerRef.current.clientWidth - 48;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, availableWidth / baseViewport.width));
    usePdfStore.getState().setZoom(tabId, newZoom);
  }, [tabId]);

  const handleFitPage = useCallback(async () => {
    const tab = usePdfStore.getState().tabs[tabId];
    if (!tab?.pdfDocument || !containerRef.current) return;
    const page = await tab.pdfDocument.getPage(tab.currentPage);
    const baseViewport = page.getViewport({ scale: 1.0, rotation: tab.rotation });
    const availableWidth = containerRef.current.clientWidth - 48;
    const availableHeight = containerRef.current.clientHeight - 48;
    const zoomW = availableWidth / baseViewport.width;
    const zoomH = availableHeight / baseViewport.height;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zoomW, zoomH)));
    usePdfStore.getState().setZoom(tabId, newZoom);
  }, [tabId]);

  const handleRotate = useCallback(() => {
    const tab = usePdfStore.getState().tabs[tabId];
    if (!tab) return;
    usePdfStore.getState().setRotation(tabId, tab.rotation + 90);
  }, [tabId]);

  const handlePageInputCommit = useCallback(
    (value: string) => {
      const tab = usePdfStore.getState().tabs[tabId];
      if (!tab?.pdfInfo) return;
      const n = parseInt(value, 10);
      if (!isNaN(n) && n >= 1 && n <= tab.pdfInfo.page_count) {
        usePdfStore.getState().setCurrentPage(tabId, n);
      }
    },
    [tabId]
  );

  // ── アノテーションコールバック ─────────────────────────────────────────────
  const handleAnnotationCreate = useCallback(
    (annotation: Annotation) => {
      usePdfStore.getState().addAnnotation(tabId, annotation);
    },
    [tabId]
  );

  const handleAnnotationDelete = useCallback(
    (pageIndex: number, id: string) => {
      usePdfStore.getState().deleteAnnotation(tabId, pageIndex, id);
    },
    [tabId]
  );

  const handleAnnotationSelect = useCallback(
    (id: string | null) => {
      usePdfStore.getState().setSelectedAnnotationId(tabId, id);
    },
    [tabId]
  );

  // ── ローディング / エラー状態 ──────────────────────────────────────────────
  if (!tabState) return null;

  if (tabState.isLoading || (!tabState.pdfDocument && !tabState.error)) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "var(--text-secondary)", backgroundColor: "var(--viewer-bg)" }}
      >
        読み込み中...
      </div>
    );
  }

  if (tabState.error) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "#f87171", backgroundColor: "var(--viewer-bg)" }}
      >
        エラー: {tabState.error}
      </div>
    );
  }

  if (!tabState.pdfDocument || !tabState.pdfInfo) return null;

  const {
    pdfDocument,
    pdfInfo,
    currentPage,
    zoom,
    rotation,
    displayMode,
    isSidebarOpen,
    sidebarMode,
    annotationMode,
    selectedAnnotationId,
    highlightColor,
    annotations,
  } = tabState;
  const pageCount = pdfInfo.page_count;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ツールバー */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0 text-sm select-none"
        style={{
          backgroundColor: "var(--tabbar-bg)",
          borderBottom: "1px solid var(--border-color)",
          color: "var(--text-primary)",
        }}
      >
        {/* サイドバー切り替え */}
        <button
          onClick={() => usePdfStore.getState().toggleSidebar(tabId)}
          className="px-2 py-0.5 rounded hover:bg-white/10"
          title="サイドバー切り替え"
        >
          ☰
        </button>

        {/* サイドバーモード切り替え — アウトラインがある場合のみ表示 */}
        {isSidebarOpen && pdfInfo.outlines.length > 0 && (
          <button
            onClick={() =>
              usePdfStore.getState().setSidebarMode(
                tabId,
                sidebarMode === "thumbnail" ? "outline" : "thumbnail"
              )
            }
            className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
            title={sidebarMode === "thumbnail" ? "目次を表示" : "サムネイルを表示"}
          >
            {sidebarMode === "thumbnail" ? "目次" : "頁"}
          </button>
        )}

        <div style={{ width: 1, height: 16, backgroundColor: "var(--border-color)" }} />

        {/* ページナビゲーション */}
        <button
          onClick={() => {
            if (currentPage > 1) usePdfStore.getState().setCurrentPage(tabId, currentPage - 1);
          }}
          disabled={currentPage <= 1}
          className="px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-40"
        >
          ‹
        </button>

        <div className="flex items-center gap-1">
          <input
            ref={pageInputRef}
            type="text"
            defaultValue={currentPage}
            key={currentPage}
            onBlur={(e) => handlePageInputCommit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handlePageInputCommit(e.currentTarget.value);
                e.currentTarget.blur();
              }
            }}
            className="text-center rounded border text-xs"
            style={{
              width: 36,
              backgroundColor: "transparent",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
              padding: "1px 4px",
            }}
          />
          <span style={{ color: "var(--text-secondary)" }}>/ {pageCount}</span>
        </div>

        <button
          onClick={() => {
            if (currentPage < pageCount) usePdfStore.getState().setCurrentPage(tabId, currentPage + 1);
          }}
          disabled={currentPage >= pageCount}
          className="px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-40"
        >
          ›
        </button>

        <div style={{ width: 1, height: 16, backgroundColor: "var(--border-color)" }} />

        {/* ズームコントロール */}
        <button
          onClick={handleZoomOut}
          disabled={zoom <= MIN_ZOOM}
          className="px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-40"
          title="縮小"
        >
          −
        </button>
        <span className="w-12 text-center text-xs" style={{ color: "var(--text-secondary)" }}>
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={handleZoomIn}
          disabled={zoom >= MAX_ZOOM}
          className="px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-40"
          title="拡大"
        >
          ＋
        </button>
        <button
          onClick={handleFitWidth}
          className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
          title="幅に合わせる"
        >
          幅
        </button>
        <button
          onClick={handleFitPage}
          className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
          title="ページ全体を表示"
        >
          頁
        </button>

        <div style={{ width: 1, height: 16, backgroundColor: "var(--border-color)" }} />

        {/* 回転 */}
        <button
          onClick={handleRotate}
          className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
          title="右に90°回転"
        >
          ↻
        </button>

        {/* 表示モード */}
        <button
          onClick={() =>
            usePdfStore.getState().setDisplayMode(
              tabId,
              displayMode === "single" ? "continuous" : "single"
            )
          }
          className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
          title={displayMode === "single" ? "連続スクロールモード" : "単ページモード"}
        >
          {displayMode === "single" ? "連続" : "単頁"}
        </button>

        <div style={{ width: 1, height: 16, backgroundColor: "var(--border-color)" }} />

        {/* アノテーション: ハイライトモード */}
        <button
          onClick={() =>
            usePdfStore.getState().setAnnotationMode(
              tabId,
              annotationMode === "highlight" ? "none" : "highlight"
            )
          }
          className="px-2 py-0.5 rounded text-xs"
          style={{
            backgroundColor:
              annotationMode === "highlight" ? "rgba(234,179,8,0.3)" : "transparent",
            color: "var(--text-primary)",
          }}
          title="テキストハイライト（テキストを選択して色を選ぶ）"
        >
          HL
        </button>

        {/* アノテーション: メモモード */}
        <button
          onClick={() =>
            usePdfStore.getState().setAnnotationMode(
              tabId,
              annotationMode === "note" ? "none" : "note"
            )
          }
          className="px-2 py-0.5 rounded text-xs"
          style={{
            backgroundColor:
              annotationMode === "note" ? "rgba(234,179,8,0.3)" : "transparent",
            color: "var(--text-primary)",
          }}
          title="メモ注釈（ページ上の任意の位置にクリック）"
        >
          📌
        </button>

        {/* 選択中アノテーション削除 */}
        {selectedAnnotationId && (
          <button
            onClick={() => {
              const store = usePdfStore.getState();
              const tab = store.tabs[tabId];
              if (!tab || !selectedAnnotationId) return;
              for (const [pageIdx, anns] of Object.entries(tab.annotations)) {
                const found = anns.find((a) => a.id === selectedAnnotationId);
                if (found) {
                  store.deleteAnnotation(tabId, Number(pageIdx), selectedAnnotationId);
                  break;
                }
              }
            }}
            className="px-2 py-0.5 rounded text-xs hover:bg-red-500/20"
            style={{ color: "#f87171" }}
            title="選択中の注釈を削除"
          >
            🗑
          </button>
        )}
      </div>

      {/* メインコンテンツ */}
      <div className="flex flex-1 overflow-hidden">
        {isSidebarOpen && (
          sidebarMode === "outline" && pdfInfo.outlines.length > 0 ? (
            <OutlineSidebar
              outlines={pdfInfo.outlines}
              currentPage={currentPage}
              onPageSelect={(p) => usePdfStore.getState().setCurrentPage(tabId, p)}
            />
          ) : (
            <ThumbnailSidebar
              filePath={filePath}
              pageCount={pageCount}
              currentPage={currentPage}
              onPageSelect={(p) => usePdfStore.getState().setCurrentPage(tabId, p)}
            />
          )
        )}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto flex justify-center"
          style={{ backgroundColor: "var(--viewer-bg, #525659)", padding: 24 }}
        >
          {displayMode === "single" ? (
            <div data-pdf-page={currentPage - 1}>
              <PdfCanvas
                pdfDocument={pdfDocument}
                pageIndex={currentPage - 1}
                scale={zoom * 1.5}
                rotation={rotation}
                annotations={annotations[currentPage - 1] ?? []}
                annotationMode={annotationMode}
                highlightColor={highlightColor}
                selectedAnnotationId={selectedAnnotationId}
                onAnnotationCreate={handleAnnotationCreate}
                onAnnotationDelete={handleAnnotationDelete}
                onAnnotationSelect={handleAnnotationSelect}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6">
              {Array.from({ length: pageCount }, (_, i) => (
                <div key={i} data-pdf-page={i}>
                  <LazyPdfCanvas
                    pdfDocument={pdfDocument}
                    pageIndex={i}
                    scale={zoom * 1.5}
                    rotation={rotation}
                    annotations={annotations[i] ?? []}
                    annotationMode={annotationMode}
                    selectedAnnotationId={selectedAnnotationId}
                    onAnnotationCreate={handleAnnotationCreate}
                    onAnnotationDelete={handleAnnotationDelete}
                    onAnnotationSelect={handleAnnotationSelect}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
