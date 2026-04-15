import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { invoke } from "@tauri-apps/api/core";

// Initialize PDF.js worker once at module load time
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

/**
 * Loads a local PDF file into a PDF.js PDFDocumentProxy.
 * Uses the read_pdf_bytes Tauri command to read the file as base64,
 * then passes the bytes directly to PDF.js (no asset protocol needed).
 */
export async function loadPdfDocument(
  filePath: string
): Promise<PDFDocumentProxy> {
  const base64 = await invoke<string>("read_pdf_bytes", { path: filePath });
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return pdfjsLib.getDocument({ data: bytes }).promise;
}

export { pdfjsLib };
