import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

const THUMB_WIDTH = 88;
const MAX_CONCURRENT = 4;
let activeRenders = 0;
const renderQueue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  return new Promise((resolve) => {
    if (activeRenders < MAX_CONCURRENT) {
      activeRenders++;
      resolve();
    } else {
      renderQueue.push(() => {
        activeRenders++;
        resolve();
      });
    }
  });
}

function releaseSemaphore() {
  activeRenders--;
  const next = renderQueue.shift();
  if (next) next();
}

function isRenderCancelled(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "RenderingCancelledException"
  );
}

interface ThumbnailItemProps {
  pdfDocument: PDFDocumentProxy;
  pageIndex: number;
  isActive: boolean;
  onClick: () => void;
}

function ThumbnailItem({
  pdfDocument,
  pageIndex,
  isActive,
  onClick,
}: ThumbnailItemProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    acquireSemaphore().then(async () => {
      if (cancelled) {
        releaseSemaphore();
        return;
      }
      try {
        const page = await pdfDocument.getPage(pageIndex + 1);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = THUMB_WIDTH / baseViewport.width;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Failed to get canvas 2D context");

        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
        if (cancelled) return;

        setThumbUrl(canvas.toDataURL("image/png"));
        setError(null);
      } catch (err) {
        if (cancelled || isRenderCancelled(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Thumbnail render failed (page ${pageIndex + 1}):`, err);
        setError(message);
      } finally {
        releaseSemaphore();
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [isVisible, pdfDocument, pageIndex]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      className="flex flex-col items-center gap-1 p-1 w-full rounded"
      style={{
        backgroundColor: isActive ? "var(--tab-active-bg)" : "transparent",
        outline: isActive ? "2px solid var(--accent, #3b82f6)" : "none",
        outlineOffset: 1,
        cursor: "pointer",
        border: "none",
      }}
    >
      <div
        className="rounded overflow-hidden flex items-center justify-center"
        style={{
          width: THUMB_WIDTH,
          minHeight: 120,
          backgroundColor: thumbUrl ? "transparent" : "#e5e7eb",
        }}
      >
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={`Page ${pageIndex + 1}`}
            style={{ width: "100%", display: "block" }}
            draggable={false}
          />
        ) : error ? (
          <span
            className="text-xs px-1 text-center"
            style={{ color: "#f87171" }}
            title={error}
          >
            失敗
          </span>
        ) : (
          <span
            className="text-xs"
            style={{ color: "var(--text-secondary)" }}
          >
            ...
          </span>
        )}
      </div>
      <span
        className="text-xs select-none"
        style={{
          color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
        }}
      >
        {pageIndex + 1}
      </span>
    </button>
  );
}

interface ThumbnailSidebarProps {
  pdfDocument: PDFDocumentProxy;
  pageCount: number;
  currentPage: number; // 1-based
  onPageSelect: (page: number) => void;
}

export function ThumbnailSidebar({
  pdfDocument,
  pageCount,
  currentPage,
  onPageSelect,
}: ThumbnailSidebarProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 152,
    overscan: 3,
  });

  useEffect(() => {
    virtualizer.scrollToIndex(currentPage - 1, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  return (
    <div
      className="flex flex-col overflow-hidden flex-shrink-0"
      style={{
        width: 108,
        borderRight: "1px solid var(--border-color)",
        backgroundColor: "var(--sidebar-bg, var(--tabbar-bg))",
      }}
    >
      <div
        className="text-xs font-medium px-2 py-1 flex-shrink-0"
        style={{
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        ページ
      </div>
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => (
            <div
              key={virtualItem.key}
              style={{
                position: "absolute",
                top: virtualItem.start,
                width: "100%",
                height: virtualItem.size,
              }}
            >
              <ThumbnailItem
                pdfDocument={pdfDocument}
                pageIndex={virtualItem.index}
                isActive={virtualItem.index + 1 === currentPage}
                onClick={() => onPageSelect(virtualItem.index + 1)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
