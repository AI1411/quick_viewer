import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { PdfViewer } from "../PdfViewer";
import { usePdfStore } from "../../../stores/pdfStore";
import { useToastStore } from "../../../stores/toastStore";
import type { Annotation } from "../../../types";

vi.mock("../PdfCanvas", () => ({ PdfCanvas: () => null }));
vi.mock("../ThumbnailSidebar", () => ({ ThumbnailSidebar: () => null }));
vi.mock("../OutlineSidebar", () => ({ OutlineSidebar: () => null }));

const saved = { id: "a1", pageIndex: 0 } as unknown as Annotation;
const added = { id: "a2", pageIndex: 1 } as unknown as Annotation;

let loadAnnotations: () => Promise<string>;
let loadPdf: () => Promise<unknown>;
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "load_annotations") return loadAnnotations();
    if (cmd === "read_pdf_info") return Promise.reject(new Error("lopdf cannot parse"));
    return Promise.resolve(undefined);
  }),
}));
vi.mock("../../../lib/pdfLib", () => ({ loadPdfDocument: vi.fn(() => loadPdf()) }));

const fakeDoc = () => Promise.resolve({ numPages: 3, destroy: vi.fn() });
const saves = () => calls.filter((c) => c.cmd === "save_annotations").map((c) => c.args.annotationsJson);
const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  calls.length = 0;
  usePdfStore.setState({ tabs: {} });
  useToastStore.setState({ toasts: [] });
  loadAnnotations = () => Promise.resolve(JSON.stringify([saved]));
  loadPdf = fakeDoc;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("PdfViewer の注釈保存", () => {
  it("PDF の読み込みに失敗しても保存済みの注釈を [] で上書きしない", async () => {
    loadPdf = () => Promise.reject(new Error("broken pdf"));
    render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(1000);
    expect(saves()).toEqual([]);
  });

  it("読み込み中にタブを閉じても注釈を [] で上書きしない", async () => {
    loadPdf = () => new Promise(() => {});
    const { unmount } = render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(1000);
    unmount();
    await flush(1000);
    expect(saves()).toEqual([]);
  });

  it("注釈ファイルを読めないときは保存を止めて警告する", async () => {
    loadAnnotations = () => Promise.reject("annotation sidecar exceeds size limit (10 MB)");
    render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(0);
    act(() => usePdfStore.getState().addAnnotation("t1", added));
    await flush(1000);
    expect(saves()).toEqual([]);
    expect(useToastStore.getState().toasts.map((t) => t.type)).toContain("warning");
  });

  it("lopdf がメタ情報を読めなくても pdf.js のページ数で表示し、読み込んだ注釈は書き戻さない", async () => {
    render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(1000);
    const tab = usePdfStore.getState().tabs.t1;
    expect(tab?.error).toBeNull();
    expect(tab?.pdfInfo?.page_count).toBe(3);
    expect(saves()).toEqual([]);
  });

  it("追加直後にタブを閉じても、待機中の注釈を書き出す", async () => {
    const { unmount } = render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(0);
    act(() => usePdfStore.getState().addAnnotation("t1", added));
    await flush(100);
    unmount();
    expect(saves()).toEqual([JSON.stringify([saved, added])]);
  });
});

describe("PdfViewer のキーボード操作", () => {
  it("メモ入力中の矢印キーではページを移動しない", async () => {
    render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(0);
    const note = document.createElement("textarea");
    document.body.appendChild(note);
    note.focus();

    act(() => {
      note.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(usePdfStore.getState().tabs.t1?.currentPage).toBe(1);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(usePdfStore.getState().tabs.t1?.currentPage).toBe(2);
    note.remove();
  });
});

describe("PdfViewer の連続表示", () => {
  it("ページを指定するとそのページまでスクロールする", async () => {
    class NoopObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", NoopObserver);
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("data-page") ?? "");
    };

    const { container } = render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(0);
    act(() => usePdfStore.getState().setDisplayMode("t1", "continuous"));
    act(() => usePdfStore.getState().setCurrentPage("t1", 3));

    expect(container.querySelectorAll("[data-page]").length).toBe(3);
    expect(scrolled[scrolled.length - 1]).toBe("3");
    vi.unstubAllGlobals();
  });
});
