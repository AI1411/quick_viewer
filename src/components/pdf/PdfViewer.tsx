import { useEffect, useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { usePdfStore } from "../../stores/pdfStore";
import { useSearchStore } from "../../stores/searchStore";
import { showError, showInfo, showWarning } from "../../stores/toastStore";
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

function parseAnnotations(json: string): Annotation[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("annotations sidecar is not an array");
  return parsed as Annotation[];
}

function saveAnnotationsJson(pdfPath: string, annotationsJson: string) {
  invoke("save_annotations", { pdfPath, annotationsJson }).catch((err: unknown) => {
    showError(`注釈の保存に失敗しました: ${String(err)}`);
  });
}

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
  const [placeholderSize, setPlaceholderSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // Reserve real page viewport size so lazy mount/unmount does not jump scroll
  useEffect(() => {
    let cancelled = false;
    pdfDocument.getPage(pageIndex + 1).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale, rotation });
      setPlaceholderSize({ width: viewport.width, height: viewport.height });
    });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument, pageIndex, scale, rotation]);

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
    <div
      ref={ref}
      style={{
        minWidth: placeholderSize?.width ?? 400,
        minHeight: placeholderSize?.height ?? 400,
      }}
    >
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
  // 注釈 sidecar を正しく読めた場合だけ true。読込失敗中に既定値 [] で上書きしないためのゲート
  const annotationsWritableRef = useRef(false);
  const lastSavedJsonRef = useRef<string | null>(null);
  const pendingSaveRef = useRef<string | null>(null);

  // ── 初期化 ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let localDoc: PDFDocumentProxy | null = null;
    let cancelled = false;
    const store = usePdfStore.getState();
    store.initTab(tabId);
    store.setLoading(tabId, true);
    annotationsWritableRef.current = false;
    lastSavedJsonRef.current = null;
    pendingSaveRef.current = null;

    Promise.all([
      loadPdfDocument(filePath).then(async (doc) => {
        const info = await extractPdfInfo(doc);
        return { doc, info };
      }),
      invoke<string>("load_annotations", { pdfPath: filePath }).then(parseAnnotations, () => null),
    ])
      .then(([{ doc, info }, anns]) => {
        if (cancelled) { doc.destroy(); return; }
        localDoc = doc;
        store.setPdfInfo(tabId, info);
        store.setPdfDocument(tabId, doc);
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
      if (localDoc) clearPdfTextCache(localDoc);
      localDoc?.destroy();
      // 破棄した文書がストアに残ると、再読み込みでマウントし直した直後の描画に使われてしまう
      // (タブを閉じたときは状態ごと消えているので何もしない)
      if (usePdfStore.getState().tabs[tabId]) usePdfStore.getState().setPdfDocument(tabId, null);
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

  // ── キーボードナビゲーション（アクティブタブのみ）─────────────────────────
  useEffect(() => {
    if (!isActive) return;

    function handleKey(e: KeyboardEvent) {
      const store = usePdfStore.getState();
      const tab = store.tabs[tabId];
      if (!tab?.pdfInfo) return;

      // 入力要素にフォーカスがあるときは矢印キーを無視
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }

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

  // ── 連続表示: currentPage ↔ スクロール位置の同期 ─────────────────────────
  const scrollingToPageRef = useRef(false);
  const lastScrolledPageRef = useRef<number | null>(null);

  // スクロール → 最も見えているページを currentPage に反映
  useEffect(() => {
    if (!isActive) return;
    const tab = usePdfStore.getState().tabs[tabId];
    if (!tab || tab.displayMode !== "continuous") return;
    const container = containerRef.current;
    if (!container) return;

    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageAttr = (entry.target as HTMLElement).dataset.pdfPage;
          if (pageAttr == null) continue;
          const pageIndex = Number(pageAttr);
          if (entry.isIntersecting) {
            ratios.set(pageIndex, entry.intersectionRatio);
          } else {
            ratios.delete(pageIndex);
          }
        }
        if (ratios.size === 0) return;
        if (scrollingToPageRef.current) return;

        let bestPage = -1;
        let bestRatio = -1;
        for (const [pageIndex, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = pageIndex;
          }
        }
        if (bestPage < 0) return;
        const nextPage = bestPage + 1; // 1-based
        const current = usePdfStore.getState().tabs[tabId]?.currentPage;
        if (current !== nextPage) {
          // スクロール追従更新なので再スクロールしない
          lastScrolledPageRef.current = nextPage;
          usePdfStore.getState().setCurrentPage(tabId, nextPage);
        }
      },
      { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );

    const pages = container.querySelectorAll("[data-pdf-page]");
    pages.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [
    isActive,
    tabId,
    tabState?.displayMode,
    tabState?.pdfDocument,
    tabState?.pdfInfo?.page_count,
  ]);

  // currentPage 変更（ツールバー / サムネ / 目次 / 矢印）→ 該当ページへスクロール
  useEffect(() => {
    if (!isActive) return;
    const tab = usePdfStore.getState().tabs[tabId];
    if (!tab || tab.displayMode !== "continuous") return;
    const page = tab.currentPage;
    if (lastScrolledPageRef.current === page) return;
    const el = containerRef.current?.querySelector(
      `[data-pdf-page="${page - 1}"]`
    );
    if (!el) return;
    lastScrolledPageRef.current = page;
    scrollingToPageRef.current = true;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    const timer = setTimeout(() => {
      scrollingToPageRef.current = false;
    }, 400);
    return () => clearTimeout(timer);
  }, [isActive, tabId, tabState?.currentPage, tabState?.displayMode]);

  // 再読み込みで引き継いだページへ、文書を読み込み終えた時点で移動する。
  // 何もしないと先頭が表示され、スクロール追従が currentPage を 1 に戻してしまう
  const loadedDocument = tabState?.pdfDocument;
  useEffect(() => {
    const tab = usePdfStore.getState().tabs[tabId];
    if (!loadedDocument || !tab?.pdfInfo) return;
    // ファイルのページ数が減っていたら、最後のページに収める
    const page = Math.min(tab.currentPage, tab.pdfInfo.page_count);
    if (page !== tab.currentPage) usePdfStore.getState().setCurrentPage(tabId, page);
    if (tab.displayMode !== "continuous" || page <= 1) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    lastScrolledPageRef.current = page;
    scrollingToPageRef.current = true;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // 各ページの枠は寸法が分かるまで仮の高さなので、手前のページの寸法が決まって
    // 描画に反映されてから移動する。先に動くと、後から枠が伸びて別のページがずれ込む
    Promise.all(Array.from({ length: page }, (_, i) => loadedDocument.getPage(i + 1)))
      .then(nextFrame)
      .then(nextFrame)
      .catch(() => {})
      .then(() => {
        if (cancelled) return;
        containerRef.current
          ?.querySelector(`[data-pdf-page="${page - 1}"]`)
          ?.scrollIntoView({ block: "start" });
        timer = setTimeout(() => {
          scrollingToPageRef.current = false;
        }, 400);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      scrollingToPageRef.current = false;
    };
  }, [tabId, loadedDocument]);

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

  const handleExportAnnotations = useCallback(async () => {
    try {
      const base =
        filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i, "") ?? "annotations";
      const outputPath = await saveDialog({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: `${base}-annotations.json`,
      });
      if (!outputPath) return;
      await invoke("export_annotations", { pdfPath: filePath, outputPath });
      showInfo("注釈をエクスポートしました");
    } catch (err) {
      showError(`注釈のエクスポートに失敗しました: ${String(err)}`);
    }
  }, [filePath]);

  const handleImportAnnotations = useCallback(async () => {
    try {
      const inputPath = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!inputPath || typeof inputPath !== "string") return;
      const json = await invoke<string>("import_annotations", {
        pdfPath: filePath,
        inputPath,
      });
      if (json.length < 5 * 1024 * 1024) {
        const anns: Annotation[] = JSON.parse(json);
        if (Array.isArray(anns)) {
          usePdfStore.getState().setAnnotations(tabId, anns);
        }
      }
      showInfo("注釈をインポートしました");
    } catch (err) {
      showError(`注釈のインポートに失敗しました: ${String(err)}`);
    }
  }, [filePath, tabId]);

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

        <div style={{ width: 1, height: 16, backgroundColor: "var(--border-color)" }} />

        <button
          onClick={handleExportAnnotations}
          className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
          title="注釈を JSON でエクスポート"
        >
          書出
        </button>
        <button
          onClick={handleImportAnnotations}
          className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
          title="注釈を JSON からインポート"
        >
          読込
        </button>
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
              pdfDocument={pdfDocument}
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
