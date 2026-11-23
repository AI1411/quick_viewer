import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findPdfMatches,
  getPageText,
  clearPdfTextCache,
  _getCachedPageCount,
} from "../pdfTextIndex";
import type { PDFDocumentProxy } from "pdfjs-dist";

function mockDoc(pageTexts: string[]): PDFDocumentProxy {
  const pages = pageTexts.map((str) => ({
    getTextContent: vi.fn().mockResolvedValue({
      items: str.split("").length
        ? [{ str }]
        : [],
    }),
  }));
  // Prefer whole-string items for realism
  pageTexts.forEach((str, i) => {
    pages[i].getTextContent = vi.fn().mockResolvedValue({
      items: [{ str }],
    });
  });

  return {
    numPages: pageTexts.length,
    getPage: vi.fn(async (n: number) => pages[n - 1]),
  } as unknown as PDFDocumentProxy;
}

describe("pdfTextIndex", () => {
  let doc: PDFDocumentProxy;

  beforeEach(() => {
    doc = mockDoc(["Hello world", "foo Hello bar Hello", "nothing here"]);
  });

  it("getPageText caches per page", async () => {
    const t1 = await getPageText(doc, 0);
    const t2 = await getPageText(doc, 0);
    expect(t1).toBe("Hello world");
    expect(t2).toBe("Hello world");
    expect(doc.getPage).toHaveBeenCalledTimes(1);
    expect(_getCachedPageCount(doc)).toBe(1);
  });

  it("findPdfMatches indexes all pages with page + matchIndexOnPage", async () => {
    const matches = await findPdfMatches(doc, "Hello", {
      useRegex: false,
      caseSensitive: true,
    });
    expect(matches).toEqual([
      { pageIndex: 0, matchIndexOnPage: 0 },
      { pageIndex: 1, matchIndexOnPage: 0 },
      { pageIndex: 1, matchIndexOnPage: 1 },
    ]);
  });

  it("findPdfMatches respects caseSensitive false", async () => {
    const matches = await findPdfMatches(doc, "hello", {
      useRegex: false,
      caseSensitive: false,
    });
    expect(matches).toHaveLength(3);
  });

  it("findPdfMatches returns [] for empty query", async () => {
    const matches = await findPdfMatches(doc, "", {
      useRegex: false,
      caseSensitive: false,
    });
    expect(matches).toEqual([]);
  });

  it("findPdfMatches stops early when cancelled", async () => {
    const signal = { cancelled: true };
    const matches = await findPdfMatches(
      doc,
      "Hello",
      { useRegex: false, caseSensitive: true },
      signal
    );
    expect(matches).toEqual([]);
    expect(doc.getPage).not.toHaveBeenCalled();
  });

  it("clearPdfTextCache drops cached pages", async () => {
    await getPageText(doc, 0);
    expect(_getCachedPageCount(doc)).toBe(1);
    clearPdfTextCache(doc);
    expect(_getCachedPageCount(doc)).toBe(0);
  });
});
