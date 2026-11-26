import { useEffect, useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePdfStore } from "../../stores/pdfStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { showError, showWarning } from "../../stores/toastStore";
import { loadPdfDocument } from "../../lib/pdfLib";
import { PdfCanvas } from "./PdfCanvas";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { OutlineSidebar } from "./OutlineSidebar";
import type { Annotation, PdfInfo } from "../../types";
import type { PDFDocumentProxy } from "pdfjs-dist";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;
const ZOOM_STEP = 0.25;

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function parseAnnotations(json: string): Annotation[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("annotations sidecar is not an array");
  return parsed as Annotation[];
}

function emptyPdfInfo(): PdfInfo {
  return {
    page_count: 0,
    title: null,
    author: null,
    subject: null,
    creator: null,
    producer: null,
    creation_date: null,
    modification_date: null,
    encrypted: false,
    outlines: [],
  };
}

function saveAnnotationsJson(pdfPath: string, annotationsJson: string) {
  invoke("save_annotations", { pdfPath, annotationsJson }).catch((err: unknown) => {
    showError(`注釈の保存に失敗しました: ${String(err)}`);
  });
}

interface PdfViewerProps {
  tabId: string;
  filePath: string;
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

export function PdfViewer({ tabId, filePath }: PdfViewerProps) {
  const tabState = usePdfStore((s) => s.tabs[tabId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  // 注釈 sidecar を正しく読めた場合だけ true。読込失敗中に既定値 [] で上書きしないためのゲート
  const annotationsWritableRef = useRef(false);
  const lastSavedJsonRef = useRef<string | null>(null);
  const pendingSaveRef = useRef<string | null>(null);

  // ── 初期化 ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let localDoc: PDFDocumentProxy | null = null;
    let cancelled = false;
    const store = usePdfStore.getState();
    const isNewTab = !store.tabs[tabId];
    store.initTab(tabId);
    if (isNewTab) store.setDisplayMode(tabId, useSettingsStore.getState().pdfSettings.defaultViewMode);
    store.setLoading(tabId, true);
    annotationsWritableRef.current = false;
    lastSavedJsonRef.current = null;
    pendingSaveRef.current = null;

    Promise.all([
      loadPdfDocument(filePath),
      // lopdf で読めなくても pdf.js で表示できる PDF はあるので、メタ情報の失敗は致命的にしない
      invoke<PdfInfo>("read_pdf_info", { path: filePath }).catch(() => null),
      invoke<string>("load_annotations", { pdfPath: filePath }).then(parseAnnotations, () => null),
    ])
      .then(([doc, info, anns]) => {
        if (cancelled) { doc.destroy(); return; }
        localDoc = doc;
        store.setPdfInfo(tabId, { ...(info ?? emptyPdfInfo()), page_count: doc.numPages });
        store.setPdfDocument(tabId, doc);
        // 引き継いだページがファイルの変更でページ数を超えていたら収める
        const page = usePdfStore.getState().tabs[tabId]?.currentPage ?? 1;
        if (page > doc.numPages) store.setCurrentPage(tabId, Math.max(1, doc.numPages));
        store.setLoading(tabId, false);
        if (anns === null) {
          showWarning("注釈ファイルを読み込めなかったため、このファイルの注釈は保存しません");
          return;
        }
        lastSavedJsonRef.current = JSON.stringify(anns);
        if (anns.length > 0) store.setAnnotations(tabId, anns);
        annotationsWritableRef.current = true;
      })
      .catch((err) => { if (!cancelled) store.setError(tabId, String(err)); });

    return () => {
      cancelled = true;
      // デバウンス待ちの注釈を閉じる前に書き出す
      const pending = pendingSaveRef.current;
      if (pending !== null && annotationsWritableRef.current) {
        saveAnnotationsJson(filePath, pending);
      }
      pendingSaveRef.current = null;
      annotationsWritableRef.current = false;
      localDoc?.destroy();
      // 表示状態はタブ切替をまたいで残す。破棄した文書だけ外す (タブを閉じたら tabActions が消す)
      if (usePdfStore.getState().tabs[tabId]) usePdfStore.getState().setPdfDocument(tabId, null);
    };
  }, [tabId, filePath]);

  // ── 注釈の自動保存（デバウンス 500ms）────────────────────────────────────
  useEffect(() => {
    if (!annotationsWritableRef.current || !tabState?.annotations) return;
    const json = JSON.stringify(Object.values(tabState.annotations).flat());
    if (json === lastSavedJsonRef.current) return;
    pendingSaveRef.current = json;
    const timer = setTimeout(() => {
      pendingSaveRef.current = null;
      lastSavedJsonRef.current = json;
      saveAnnotationsJson(filePath, json);
    }, 500);
    return () => clearTimeout(timer);
  }, [tabState?.annotations, filePath]);

  // ── キーボードナビゲーション ───────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const store = usePdfStore.getState();
      const tab = store.tabs[tabId];
      if (!tab?.pdfInfo) return;
      // メモの入力欄や検索欄で矢印キーを押したときはページを移動しない
      if (isTextEntryTarget(e.target)) return;

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
  }, [tabId]);

  // ── 連続表示: ページ移動でスクロールし、スクロールで現在ページを更新する ──────
  const scrolledPageRef = useRef<number | null>(null);
  const currentPageForScroll = tabState?.currentPage;
  const displayModeForScroll = tabState?.displayMode;
  useEffect(() => {
    if (displayModeForScroll !== "continuous" || currentPageForScroll === undefined) return;
    // スクロール位置から求めたページなら、そこへスクロールし直さない
    if (scrolledPageRef.current === currentPageForScroll) return;
    containerRef.current
      ?.querySelector(`[data-page="${currentPageForScroll}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [currentPageForScroll, displayModeForScroll]);

  const handleContinuousScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const pages = container.querySelectorAll<HTMLElement>("[data-page]");
    const top = container.getBoundingClientRect().top;
    // 上端を越えた最後のページ (ページは上から順に並ぶので二分探索)
    let lo = 0;
    let hi = pages.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pages[mid].getBoundingClientRect().top - top <= 40) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const page = found + 1;
    const store = usePdfStore.getState();
    if (store.tabs[tabId]?.currentPage !== page) {
      scrolledPageRef.current = page;
      store.setCurrentPage(tabId, page);
    }
  }, [tabId]);

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
          onScroll={displayMode === "continuous" ? handleContinuousScroll : undefined}
          className="flex-1 overflow-auto flex justify-center"
          style={{ backgroundColor: "var(--viewer-bg, #525659)", padding: 24 }}
        >
          {displayMode === "single" ? (
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
          ) : (
            <div className="flex flex-col items-center gap-6">
              {Array.from({ length: pageCount }, (_, i) => (
                <div key={i} data-page={i + 1}>
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
