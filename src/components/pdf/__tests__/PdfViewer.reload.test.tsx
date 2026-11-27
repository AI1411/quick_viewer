import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { PdfViewer } from "../PdfViewer";
import { usePdfStore } from "../../../stores/pdfStore";
import { useSettingsStore } from "../../../stores/settingsStore";

vi.mock("../PdfCanvas", () => ({ PdfCanvas: () => null }));
vi.mock("../ThumbnailSidebar", () => ({ ThumbnailSidebar: () => null }));
vi.mock("../OutlineSidebar", () => ({ OutlineSidebar: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => Promise.resolve(cmd === "load_annotations" ? "[]" : undefined)),
}));

let pageCount = 12;
vi.mock("../../../lib/pdfLib", () => ({
  loadPdfDocument: vi.fn(() =>
    Promise.resolve({
      numPages: pageCount,
      destroy: vi.fn(),
      getPage: () => Promise.resolve({ getViewport: () => ({ width: 600, height: 800 }) }),
    })
  ),
  extractPdfInfo: vi.fn((doc: { numPages: number }) =>
    Promise.resolve({
      page_count: doc.numPages,
      title: null,
      author: null,
      subject: null,
      creator: null,
      producer: null,
      creation_date: null,
      modification_date: null,
      encrypted: false,
      outlines: [],
    })
  ),
}));

class NoopIntersectionObserver {
  observe() {}
  disconnect() {}
}

/** scrollIntoView で移動した先のページ番号 (0 始まり) と、瞬時の移動かどうか */
const scrolled: Array<{ page: string | null; instant: boolean }> = [];
const loaded = (tabId: string) => waitFor(() => expect(usePdfStore.getState().tabs[tabId].pdfDocument).not.toBeNull());

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
    const smooth = typeof options === "object" && options.behavior === "smooth";
    scrolled.push({ page: this.getAttribute("data-pdf-page"), instant: !smooth });
  };
  scrolled.length = 0;
  pageCount = 12;
  usePdfStore.setState({ tabs: {} });
  useSettingsStore.setState({ pdfSettings: { defaultViewMode: "continuous" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("PdfViewer の再読み込み", () => {
  it("ページ・ズーム・回転・サイドバーを引き継ぎ、読み込み終えてから引き継いだページへ移動する", async () => {
    const first = render(<PdfViewer tabId="p1" filePath="/doc.pdf" />);
    await loaded("p1");
    act(() => {
      const store = usePdfStore.getState();
      store.setCurrentPage("p1", 7);
      store.setZoom("p1", 1.5);
      store.setRotation("p1", 90);
      store.toggleSidebar("p1");
    });

    // ファイルが外部で変更され、再読み込みでビューアがマウントし直される
    first.unmount();
    scrolled.length = 0;
    render(<PdfViewer tabId="p1" filePath="/doc.pdf" />);
    await loaded("p1");

    // 手前のページの寸法が確定する前に動くと、後から位置がずれる。瞬時に 7 ページ目へ移動する
    await waitFor(() => expect(scrolled).toEqual([{ page: "6", instant: true }]));
    expect(usePdfStore.getState().tabs.p1).toMatchObject({
      currentPage: 7,
      zoom: 1.5,
      rotation: 90,
      isSidebarOpen: false,
    });
  });

  it("ページ数が減っていたら最後のページに収める", async () => {
    const first = render(<PdfViewer tabId="p2" filePath="/doc.pdf" />);
    await loaded("p2");
    act(() => usePdfStore.getState().setCurrentPage("p2", 10));

    first.unmount();
    pageCount = 3;
    render(<PdfViewer tabId="p2" filePath="/doc.pdf" />);
    await loaded("p2");

    await waitFor(() => expect(usePdfStore.getState().tabs.p2.currentPage).toBe(3));
  });

  it("初めて開いたときは先頭のままで、移動しない", async () => {
    render(<PdfViewer tabId="p3" filePath="/doc.pdf" />);
    await loaded("p3");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(usePdfStore.getState().tabs.p3.currentPage).toBe(1);
    expect(scrolled.filter((s) => s.instant)).toEqual([]);
  });
});
