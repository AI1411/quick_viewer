import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import type { PdfPageData } from "../../types";

interface ThumbnailItemProps {
  filePath: string;
  pageIndex: number;
  isActive: boolean;
  onClick: () => void;
}

function ThumbnailItem({
  filePath,
  pageIndex,
  isActive,
  onClick,
}: ThumbnailItemProps) {
  const [imageData, setImageData] = useState<PdfPageData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  // Lazy-load: only invoke Rust when the thumbnail scrolls into view
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
    invoke<PdfPageData>("read_pdf_page", {
      path: filePath,
      pageIndex,
      scale: 0.2,
    })
      .then(setImageData)
      .catch(console.error);
  }, [isVisible, filePath, pageIndex]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      className="flex flex-col items-center gap-1 p-1 w-full rounded"
      style={{
        backgroundColor: isActive
          ? "var(--tab-active-bg)"
          : "transparent",
        outline: isActive ? "2px solid var(--accent, #3b82f6)" : "none",
        outlineOffset: 1,
        cursor: "pointer",
        border: "none",
      }}
    >
      <div
        className="rounded overflow-hidden flex items-center justify-center"
        style={{
          width: 88,
          minHeight: 120,
          backgroundColor: imageData ? "transparent" : "#e5e7eb",
        }}
      >
        {imageData ? (
          <img
            src={`data:image/png;base64,${imageData.image_base64}`}
            alt={`Page ${pageIndex + 1}`}
            style={{ width: "100%", display: "block" }}
            draggable={false}
          />
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
        style={{ color: isActive ? "var(--text-primary)" : "var(--text-secondary)" }}
      >
        {pageIndex + 1}
      </span>
    </button>
  );
}

interface ThumbnailSidebarProps {
  filePath: string;
  pageCount: number;
  currentPage: number; // 1-based
  onPageSelect: (page: number) => void;
}

export function ThumbnailSidebar({
  filePath,
  pageCount,
  currentPage,
  onPageSelect,
}: ThumbnailSidebarProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 152, // thumbnail height + page number + gap
    overscan: 3,
  });

  // Scroll active thumbnail into view when page changes
  useEffect(() => {
    virtualizer.scrollToIndex(currentPage - 1, { align: "auto" });
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
                filePath={filePath}
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
