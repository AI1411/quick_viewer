import type { PDFDocumentProxy } from "pdfjs-dist";
import { buildRegex } from "./searchHighlight";
import type { SearchOptions } from "../stores/searchStore";

/** One search hit in a PDF document (0-based page index). */
export interface PdfTextMatch {
  pageIndex: number;
  /** 0-based occurrence index among matches on that page. */
  matchIndexOnPage: number;
}

/** Soft cache of page text keyed by PDFDocumentProxy identity. */
const pageTextCache = new WeakMap<PDFDocumentProxy, Map<number, string>>();

function getCache(doc: PDFDocumentProxy): Map<number, string> {
  let cache = pageTextCache.get(doc);
  if (!cache) {
    cache = new Map();
    pageTextCache.set(doc, cache);
  }
  return cache;
}

/** Extract concatenated text for a single page (0-based), with cache. */
export async function getPageText(
  doc: PDFDocumentProxy,
  pageIndex: number
): Promise<string> {
  const cache = getCache(doc);
  const cached = cache.get(pageIndex);
  if (cached !== undefined) return cached;

  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join("");
  cache.set(pageIndex, text);
  return text;
}

/**
 * Lazily index all pages and collect regex matches.
 * Pages are fetched sequentially so the first match can surface early,
 * but the returned promise resolves when every page has been scanned.
 */
export async function findPdfMatches(
  doc: PDFDocumentProxy,
  query: string,
  options: SearchOptions,
  signal?: { cancelled: boolean }
): Promise<PdfTextMatch[]> {
  const regex = buildRegex(query, options);
  if (!regex) return [];

  const matches: PdfTextMatch[] = [];
  const pageCount = doc.numPages;

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    if (signal?.cancelled) return matches;
    const text = await getPageText(doc, pageIndex);
    if (signal?.cancelled) return matches;

    regex.lastIndex = 0;
    let matchIndexOnPage = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      matches.push({ pageIndex, matchIndexOnPage });
      matchIndexOnPage++;
      if (m[0].length === 0) regex.lastIndex++;
    }
  }

  return matches;
}

/** Clear cached text for a document (e.g. after destroy). */
export function clearPdfTextCache(doc: PDFDocumentProxy): void {
  pageTextCache.delete(doc);
}

/** Test helper: reset all caches by discarding WeakMap entries via GC only — no-op for production. */
export function _getCachedPageCount(doc: PDFDocumentProxy): number {
  return getCache(doc).size;
}
