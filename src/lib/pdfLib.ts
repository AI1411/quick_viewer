import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { invoke } from "@tauri-apps/api/core";
import type { OutlineItem, PdfInfo } from "../types";

// Initialize PDF.js worker once at module load time
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

/** pdf.js outline node shape (subset we use). */
export type PdfJsOutlineNode = {
  title: string;
  dest: string | unknown[] | null;
  items: PdfJsOutlineNode[];
};

/**
 * Loads a local PDF file into a PDF.js PDFDocumentProxy.
 * Uses read_pdf_bytes which returns raw bytes via tauri::ipc::Response.
 */
export async function loadPdfDocument(
  filePath: string
): Promise<PDFDocumentProxy> {
  const buffer = await invoke<ArrayBuffer>("read_pdf_bytes", { path: filePath });
  const bytes = new Uint8Array(buffer);
  return pdfjsLib.getDocument({ data: bytes }).promise;
}

async function destToPageIndex(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null
): Promise<number | null> {
  if (dest == null) return null;

  let destArray: unknown[] | null;
  if (typeof dest === "string") {
    destArray = await doc.getDestination(dest);
  } else if (Array.isArray(dest)) {
    destArray = dest;
  } else {
    return null;
  }

  if (!destArray || destArray.length === 0) return null;

  try {
    // First element is a page ref (or page number in rare cases)
    const ref = destArray[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0];
    return await doc.getPageIndex(ref);
  } catch {
    return null;
  }
}

/**
 * Converts a pdf.js outline tree into our OutlineItem shape (0-based page indices).
 */
export async function convertPdfJsOutline(
  doc: PDFDocumentProxy,
  nodes: PdfJsOutlineNode[] | null | undefined,
  level = 0
): Promise<OutlineItem[]> {
  if (!nodes || nodes.length === 0) return [];

  const items: OutlineItem[] = [];
  for (const node of nodes) {
    const page = await destToPageIndex(doc, node.dest);
    const children = await convertPdfJsOutline(doc, node.items, level + 1);
    items.push({
      title: node.title || "(Untitled)",
      page,
      level,
      children,
    });
  }
  return items;
}

function metaString(info: Record<string, unknown>, key: string): string | null {
  const v = info[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Builds PdfInfo from an already-loaded pdf.js document (no Rust/lopdf pass).
 */
export async function extractPdfInfo(doc: PDFDocumentProxy): Promise<PdfInfo> {
  const [metaResult, outlineNodes] = await Promise.all([
    doc.getMetadata().catch(() => null),
    doc.getOutline().catch(() => null),
  ]);

  const info = (metaResult?.info ?? {}) as Record<string, unknown>;
  const outlines = await convertPdfJsOutline(
    doc,
    outlineNodes as PdfJsOutlineNode[] | null
  );

  return {
    page_count: doc.numPages,
    title: metaString(info, "Title"),
    author: metaString(info, "Author"),
    subject: metaString(info, "Subject"),
    creator: metaString(info, "Creator"),
    producer: metaString(info, "Producer"),
    creation_date: metaString(info, "CreationDate"),
    modification_date: metaString(info, "ModDate"),
    // Successfully opened via pdf.js ⇒ readable without password prompt
    encrypted: false,
    outlines,
  };
}

export { pdfjsLib };
