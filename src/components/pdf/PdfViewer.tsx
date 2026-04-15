import { useEffect, useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePdfStore } from "../../stores/pdfStore";
import { loadPdfDocument } from "../../lib/pdfLib";
import { PdfCanvas } from "./PdfCanvas";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { OutlineSidebar } from "./OutlineSidebar";
import type { PdfInfo } from "../../types";
import type { PDFDocumentProxy } from "pdfjs-dist";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;
const ZOOM_STEP = 0.25;

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
}

function LazyPdfCanvas({ pdfDocument, pageIndex, scale, rotation }: LazyPdfCanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) setIsVisible(true); },
      { rootMargin: "200px" }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ minHeight: 400 }}>
      {isVisible ? (
        <PdfCanvas
          pdfDocument={pdfDocument}
          pageIndex={pageIndex}
          scale={scale}
          rotation={rotation}
        />
      ) : (
        <div
          style={{
            width: 400,
            height: 560,
            backgroundColor: "#e5e7eb",
            borderRadius: 4,
          }}
        />
      )}
    </div>
  );
}

export function PdfViewer({ tabId, filePath }: PdfViewerProps) {
  const tabState = usePdfStore((s) => s.tabs[tabId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);

  // ── Initialization ─────────────────────────────────────────────────────────
  useEffect(() => {
    let localDoc: PDFDocumentProxy | null = null;
    const store = usePdfStore.getState();
    store.initTab(tabId);
    store.setLoading(tabId, true);

    Promise.all([
      invoke<PdfInfo>("read_pdf_info", { path: filePath }),
      loadPdfDocument(filePath),
    ])
      .then(([info, doc]) => {
        localDoc = doc;
        store.setPdfInfo(tabId, info);
        store.setPdfDocument(tabId, doc);
        store.setLoading(tabId, false);
      })
      .catch((err) => store.setError(tabId, String(err)));

    return () => {
      localDoc?.destroy();
      usePdfStore.getState().removeTab(tabId);
    };
  }, [tabId, filePath]);

  // ── Keyboard navigation ────────────────────────────────────────────────────
  useEffect(() => {
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
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [tabId]);

  // ── Zoom helpers ───────────────────────────────────────────────────────────
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

  // ── Loading / Error states ─────────────────────────────────────────────────
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

  const { pdfDocument, pdfInfo, currentPage, zoom, rotation, displayMode, isSidebarOpen, sidebarMode } = tabState;
  const pageCount = pdfInfo.page_count;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0 text-sm select-none"
        style={{
          backgroundColor: "var(--tabbar-bg)",
          borderBottom: "1px solid var(--border-color)",
          color: "var(--text-primary)",
        }}
      >
        {/* Sidebar toggle */}
        <button
          onClick={() => usePdfStore.getState().toggleSidebar(tabId)}
          className="px-2 py-0.5 rounded hover:bg-white/10"
          title="サイドバー切り替え"
        >
          ☰
        </button>

        {/* Sidebar mode toggle — アウトラインがある場合のみ表示 */}
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

        {/* Page navigation */}
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

        {/* Zoom controls */}
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

        {/* Rotation */}
        <button
          onClick={handleRotate}
          className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
          title="右に90°回転"
        >
          ↻
        </button>

        {/* Display mode */}
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
      </div>

      {/* Main content */}
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
            <PdfCanvas
              pdfDocument={pdfDocument}
              pageIndex={currentPage - 1}
              scale={zoom * 1.5}
              rotation={rotation}
            />
          ) : (
            <div className="flex flex-col items-center gap-6">
              {Array.from({ length: pageCount }, (_, i) => (
                <LazyPdfCanvas
                  key={i}
                  pdfDocument={pdfDocument}
                  pageIndex={i}
                  scale={zoom * 1.5}
                  rotation={rotation}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
