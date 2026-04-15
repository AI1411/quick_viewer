import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

interface PdfCanvasProps {
  pdfDocument: PDFDocumentProxy;
  /** 0-based page index */
  pageIndex: number;
  /** Render scale (1.0 = 100%) */
  scale: number;
  /** Rotation in degrees: 0 | 90 | 180 | 270 */
  rotation: number;
}

export function PdfCanvas({
  pdfDocument,
  pageIndex,
  scale,
  rotation,
}: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [isRendering, setIsRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    setIsRendering(true);

    async function render() {
      const page = await pdfDocument.getPage(pageIndex + 1); // PDF.js is 1-based
      if (cancelled) return;

      const viewport = page.getViewport({ scale, rotation });
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

  return (
    <div
      className="relative inline-block shadow-lg"
      style={{ backgroundColor: "#fff" }}
    >
      {/* Loading overlay */}
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

      {/* PDF page canvas */}
      <canvas ref={canvasRef} style={{ display: "block" }} />

      {/* Text layer for selection */}
      <div
        ref={textLayerRef}
        className="textLayer absolute top-0 left-0 overflow-hidden"
        style={{ pointerEvents: isRendering ? "none" : "auto" }}
      />
    </div>
  );
}
