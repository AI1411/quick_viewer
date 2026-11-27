import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { PdfViewer } from "../PdfViewer";
import { usePdfStore } from "../../../stores/pdfStore";
import { useToastStore } from "../../../stores/toastStore";
import { useSettingsStore } from "../../../stores/settingsStore";
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
    return Promise.resolve(undefined);
  }),
}));
vi.mock("../../../lib/pdfLib", () => ({
  loadPdfDocument: vi.fn(() => loadPdf()),
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

const fakeDoc = () =>
  // 連続表示の各ページはページ寸法を求めるため getPage を呼ぶ (PdfCanvas はモック済みなので解決しなくてよい)
  Promise.resolve({ numPages: 3, destroy: vi.fn(), getPage: () => new Promise(() => {}) });
const saves = () => calls.filter((c) => c.cmd === "save_annotations").map((c) => c.args.annotationsJson);
const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

class NoopIntersectionObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  // 連続表示のページは IntersectionObserver で遅延描画する (jsdom には無い)
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  // jsdom には scrollIntoView も無い
  Element.prototype.scrollIntoView ??= () => {};
  calls.length = 0;
  usePdfStore.setState({ tabs: {} });
  useToastStore.setState({ toasts: [] });
  loadAnnotations = () => Promise.resolve(JSON.stringify([saved]));
  loadPdf = fakeDoc;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it("読み込んだ注釈を変更なしに書き戻さない", async () => {
    render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(1000);
    expect(usePdfStore.getState().tabs.t1?.annotations[0]).toEqual([saved]);
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

    note.blur();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(usePdfStore.getState().tabs.t1?.currentPage).toBe(2);
    note.remove();
  });
});

describe("PdfViewer の既定の表示モード", () => {
  it("設定の「デフォルト表示モード」で開く", async () => {
    useSettingsStore.setState({ pdfSettings: { defaultViewMode: "single" } });
    render(<PdfViewer tabId="t1" filePath="/doc.pdf" />);
    await flush(0);
    expect(usePdfStore.getState().tabs.t1?.displayMode).toBe("single");
    useSettingsStore.setState({ pdfSettings: { defaultViewMode: "continuous" } });
  });
});
