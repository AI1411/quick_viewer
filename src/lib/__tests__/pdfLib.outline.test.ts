import { describe, it, expect, vi } from "vitest";
import { convertPdfJsOutline, type PdfJsOutlineNode } from "../pdfLib";
import type { PDFDocumentProxy } from "pdfjs-dist";

function mockDoc(
  pageIndexByDest: Record<string, number> = {}
): PDFDocumentProxy {
  return {
    getDestination: vi.fn(async (id: string) => {
      if (id in pageIndexByDest) {
        return [{ num: pageIndexByDest[id], gen: 0 }, "XYZ", null, null, null];
      }
      return null;
    }),
    getPageIndex: vi.fn(async (ref: { num: number }) => ref.num),
  } as unknown as PDFDocumentProxy;
}

describe("convertPdfJsOutline", () => {
  it("maps pdf.js outline nodes to OutlineItem with 0-based pages", async () => {
    const nodes: PdfJsOutlineNode[] = [
      {
        title: "Chapter 1",
        dest: [{ num: 0, gen: 0 }, "XYZ", null, null, null],
        items: [
          {
            title: "1.1",
            dest: [{ num: 2, gen: 0 }, "XYZ", null, null, null],
            items: [],
          },
        ],
      },
      {
        title: "No dest",
        dest: null,
        items: [],
      },
    ];

    const result = await convertPdfJsOutline(mockDoc(), nodes);

    expect(result).toEqual([
      {
        title: "Chapter 1",
        page: 0,
        level: 0,
        children: [{ title: "1.1", page: 2, level: 1, children: [] }],
      },
      { title: "No dest", page: null, level: 0, children: [] },
    ]);
  });

  it("resolves named destinations", async () => {
    const nodes: PdfJsOutlineNode[] = [
      { title: "Named", dest: "sec-2", items: [] },
    ];
    const doc = mockDoc({ "sec-2": 4 });
    const result = await convertPdfJsOutline(doc, nodes);
    expect(result[0].page).toBe(4);
    expect(doc.getDestination).toHaveBeenCalledWith("sec-2");
  });

  it("returns empty array for null/empty outline", async () => {
    expect(await convertPdfJsOutline(mockDoc(), null)).toEqual([]);
    expect(await convertPdfJsOutline(mockDoc(), [])).toEqual([]);
  });
});
