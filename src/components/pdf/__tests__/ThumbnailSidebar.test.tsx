import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { ThumbnailSidebar } from "../ThumbnailSidebar";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 152,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 152,
        size: 152,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

function mockPage(width = 612, height = 792): PDFPageProxy {
  const renderTask = {
    promise: Promise.resolve(),
    cancel: vi.fn(),
  } as unknown as RenderTask;

  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
    })),
    render: vi.fn(() => renderTask),
  } as unknown as PDFPageProxy;
}

function mockDocument(pageCount: number): PDFDocumentProxy {
  return {
    numPages: pageCount,
    getPage: vi.fn(async () => mockPage()),
  } as unknown as PDFDocumentProxy;
}

beforeEach(() => {
  class FakeIntersectionObserver {
    callback: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) {
      this.callback = cb;
    }
    observe(target: Element) {
      this.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = "";
    thresholds: number[] = [];
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    // minimal stub — page.render is mocked
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(
    () => "data:image/png;base64,AAAA"
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ThumbnailSidebar", () => {
  it("renders page labels for each page", () => {
    const doc = mockDocument(3);
    render(
      <ThumbnailSidebar
        pdfDocument={doc}
        pageCount={3}
        currentPage={1}
        onPageSelect={vi.fn()}
      />
    );
    expect(screen.getByText("ページ")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders thumbnails from pdf.js document (no Tauri invoke)", async () => {
    const doc = mockDocument(1);
    render(
      <ThumbnailSidebar
        pdfDocument={doc}
        pageCount={1}
        currentPage={1}
        onPageSelect={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(doc.getPage).toHaveBeenCalledWith(1);
    });
    await waitFor(() => {
      const img = screen.getByAltText("Page 1");
      expect(img).toHaveAttribute("src", "data:image/png;base64,AAAA");
    });
  });

  it("calls onPageSelect when a thumbnail is clicked", async () => {
    const onPageSelect = vi.fn();
    const doc = mockDocument(2);
    render(
      <ThumbnailSidebar
        pdfDocument={doc}
        pageCount={2}
        currentPage={1}
        onPageSelect={onPageSelect}
      />
    );

    await waitFor(() => expect(doc.getPage).toHaveBeenCalled());
    fireEvent.click(screen.getByText("2"));
    expect(onPageSelect).toHaveBeenCalledWith(2);
  });

  it("surfaces render errors instead of swallowing them", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = {
      numPages: 1,
      getPage: vi.fn(async () => {
        throw new Error("render boom");
      }),
    } as unknown as PDFDocumentProxy;

    render(
      <ThumbnailSidebar
        pdfDocument={doc}
        pageCount={1}
        currentPage={1}
        onPageSelect={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("失敗")).toBeInTheDocument();
    });
    expect(screen.getByTitle("render boom")).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
