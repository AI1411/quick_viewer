import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchStore } from "../../stores/searchStore";
import { highlightTextNodes, clearSearchMarks, applyMarkStyles } from "../../lib/searchHighlight";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import { AnnotationLayer } from "./AnnotationLayer";
import { rectToPageSpace, type PageSize } from "../../lib/annotationGeometry";
import type {
  Annotation,
  AnnotationColor,
  AnnotationRect,
  HighlightAnnotation,
  NoteAnnotation,
} from "../../types";

const HIGHLIGHT_COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: "黄",
  green: "緑",
  blue: "青",
  pink: "ピンク",
};

const HIGHLIGHT_COLORS_CSS: Record<AnnotationColor, string> = {
  yellow: "#FFEB3B",
  green: "#4CAF50",
  blue: "#2196F3",
  pink: "#E91E63",
};

interface PdfCanvasProps {
  pdfDocument: PDFDocumentProxy;
  /** 0-based page index */
  pageIndex: number;
  /** Render scale (1.0 = 100%) */
  scale: number;
  /** Rotation in degrees: 0 | 90 | 180 | 270 */
  rotation: number;
  annotations: Annotation[];
  annotationMode: "none" | "highlight" | "note";
  highlightColor: AnnotationColor;
  selectedAnnotationId: string | null;
  onAnnotationCreate: (annotation: Annotation) => void;
  onAnnotationDelete: (pageIndex: number, id: string) => void;
  onAnnotationSelect: (id: string | null) => void;
}

export function PdfCanvas({
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
}: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRendering, setIsRendering] = useState(true);
  // 回転 0°・倍率 1.0 のページサイズ (注釈をページ座標で扱うために使う)
  const [pageSize, setPageSize] = useState<PageSize>({ width: 0, height: 0 });
  const searchMarksRef = useRef<HTMLElement[]>([]);
  const searchIsOpen = useSearchStore((s) => s.isOpen);
  const searchQuery = useSearchStore((s) => (s.isOpen ? s.query : ""));
  const searchUseRegex = useSearchStore((s) => s.options.useRegex);
  const searchCaseSensitive = useSearchStore((s) => s.options.caseSensitive);
  const currentMatchIndex = useSearchStore((s) => s.currentMatchIndex);

  const [colorPickerPos, setColorPickerPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const pendingRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    async function render() {
      setIsRendering(true);
      const page = await pdfDocument.getPage(pageIndex + 1); // PDF.js is 1-based
      if (cancelled) return;

      const viewport = page.getViewport({ scale, rotation });
      const base = page.getViewport({ scale: 1, rotation: 0 });
      setPageSize({ width: base.width, height: base.height });
      const canvas = canvasRef.current;
      const textDiv = textLayerRef.current;
      if (!canvas || !textDiv) return;

      const ctx = canvas.getContext("2d")!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      // Render the page to canvas
      renderTask = page.render({ canvasContext: ctx, viewport });
      await renderTask.promise;
      if (cancelled) return;

      // Render text layer for selection using TextLayer class (pdfjs-dist v4 API)
      textDiv.innerHTML = "";
      textDiv.style.width = `${viewport.width}px`;
      textDiv.style.height = `${viewport.height}px`;

      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport,
      });
      await textLayer.render();
      if (cancelled) return;

      setIsRendering(false);
    }

    render().catch((err) => {
      if (!cancelled) console.error("PdfCanvas render error:", err);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pdfDocument, pageIndex, scale, rotation]);

  // テキストレイヤーへの検索ハイライト（レンダリング完了後に適用）
  useEffect(() => {
    if (isRendering) return;
    const textDiv = textLayerRef.current;
    if (!textDiv) return;

    clearSearchMarks(textDiv);
    searchMarksRef.current = [];

    if (!searchIsOpen || !searchQuery) return;

    const marks = highlightTextNodes(textDiv, searchQuery, {
      useRegex: searchUseRegex,
      caseSensitive: searchCaseSensitive,
    });
    searchMarksRef.current = marks;

    if (marks.length > 0) {
      const idx = currentMatchIndex % marks.length;
      applyMarkStyles(marks, idx);
    }
  }, [
    isRendering,
    searchIsOpen,
    searchQuery,
    searchUseRegex,
    searchCaseSensitive,
    currentMatchIndex,
  ]);

  // テキスト選択完了時にカラーピッカーを表示（highlightモード時のみ）
  const handleMouseUp = useCallback(() => {
    if (annotationMode !== "highlight") return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!textLayerRef.current?.contains(range.commonAncestorContainer)) return;

    const container = containerRef.current;
    if (!container) return;

    const containerBounds = container.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0
    );
    if (clientRects.length === 0) return;

    pendingRangeRef.current = range.cloneRange();

    const lastRect = clientRects[clientRects.length - 1];
    const rawX = lastRect.right - containerBounds.left;
    setColorPickerPos({
      x: Math.min(rawX, (canvasRef.current?.width ?? 400) - 180),
      y: lastRect.bottom - containerBounds.top,
    });
  }, [annotationMode]);

  // 色を選択してハイライトを作成
  const handleCreateHighlight = useCallback(
    (color: AnnotationColor) => {
      const range = pendingRangeRef.current;
      const container = containerRef.current;
      if (!range || !container) {
        setColorPickerPos(null);
        return;
      }

      const containerBounds = container.getBoundingClientRect();
      const clientRects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0 && r.height > 0
      );

      // 倍率 1.0・回転 0° のページ座標に変換して保存 (回転を変えても同じ文字の上に表示する)
      const rects: AnnotationRect[] = clientRects.map((r) =>
        rectToPageSpace(
          {
            x: (r.left - containerBounds.left) / scale,
            y: (r.top - containerBounds.top) / scale,
            width: r.width / scale,
            height: r.height / scale,
          },
          rotation,
          pageSize
        )
      );

      const ann: HighlightAnnotation = {
        id: `hl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: "highlight",
        pageIndex,
        color,
        rects,
        selectedText: range.toString(),
        createdAt: new Date().toISOString(),
      };

      onAnnotationCreate(ann);
      window.getSelection()?.removeAllRanges();
      pendingRangeRef.current = null;
      setColorPickerPos(null);
    },
    [pageIndex, scale, rotation, pageSize, onAnnotationCreate]
  );

  const handleNoteCreate = useCallback(
    (ann: NoteAnnotation) => {
      onAnnotationCreate(ann);
    },
    [onAnnotationCreate]
  );

  return (
    <div
      ref={containerRef}
      className="relative inline-block shadow-lg"
      style={{ backgroundColor: "#fff" }}
      onMouseUp={handleMouseUp}
    >
      {/* ローディングオーバーレイ */}
      {isRendering && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ backgroundColor: "#f5f5f5", minWidth: 400, minHeight: 560 }}
        >
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
            レンダリング中...
          </span>
        </div>
      )}

      {/* PDF ページキャンバス */}
      <canvas ref={canvasRef} style={{ display: "block" }} />

      {/* テキストレイヤー（選択対応） */}
      <div
        ref={textLayerRef}
        className="textLayer absolute top-0 left-0 overflow-hidden"
        style={{ pointerEvents: isRendering ? "none" : "auto" }}
      />

      {/* アノテーションレイヤー */}
      {!isRendering && (
        <AnnotationLayer
          pageIndex={pageIndex}
          scale={scale}
          rotation={rotation}
          pageSize={pageSize}
          annotations={annotations}
          annotationMode={annotationMode}
          selectedAnnotationId={selectedAnnotationId}
          onAnnotationDelete={onAnnotationDelete}
          onNoteCreate={handleNoteCreate}
          onAnnotationSelect={onAnnotationSelect}
        />
      )}

      {/* ハイライト用カラーピッカー */}
      {colorPickerPos && (
        <div
          className="absolute z-50 flex items-center gap-1 p-1.5 rounded shadow-xl"
          style={{
            left: colorPickerPos.x,
            top: colorPickerPos.y + 4,
            backgroundColor: "#1e1e1e",
            border: "1px solid #3e3e42",
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {(["yellow", "green", "blue", "pink"] as AnnotationColor[]).map((color) => (
            <button
              key={color}
              className="w-6 h-6 rounded-full border-2 border-white/30 hover:scale-110 transition-transform"
              style={{
                backgroundColor: HIGHLIGHT_COLORS_CSS[color],
                cursor: "pointer",
              }}
              title={HIGHLIGHT_COLOR_LABELS[color]}
              onClick={() => handleCreateHighlight(color)}
            />
          ))}
          <button
            className="text-xs px-1 hover:text-white"
            style={{ color: "#9ca3af" }}
            onClick={() => {
              setColorPickerPos(null);
              pendingRangeRef.current = null;
              window.getSelection()?.removeAllRanges();
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
