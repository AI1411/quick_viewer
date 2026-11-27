import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { XlsxViewer } from "../XlsxViewer";
import { useXlsxStore } from "../../../stores/xlsxStore";
import type { XlsxSheetData } from "../../../types";

const cell = (v: string) => ({ value: v, raw: v, cell_type: "string" as const, format_code: null });

function sheet(rows: string[][], overrides: Partial<XlsxSheetData> = {}): XlsxSheetData {
  const cols = rows[0]?.length ?? 0;
  return {
    name: "Sheet1",
    rows: rows.map((r) => r.map(cell)),
    total_rows: rows.length,
    total_cols: cols,
    loaded_cols: cols,
    freeze_pane: { rows: 0, cols: 0 },
    ...overrides,
  };
}

let sheetData = sheet([["hello", "world"]]);
let brokenSheet: string | null = null;

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: { sheetName?: string }) => {
    if (cmd === "read_xlsx")
      return Promise.resolve({
        sheets: [
          { name: "Sheet1", index: 0 },
          { name: "Broken", index: 1 },
        ],
        active_sheet_index: 0,
      });
    if (cmd === "read_xlsx_sheet" && args.sheetName === brokenSheet) return Promise.reject("sheet is corrupted");
    if (cmd === "read_xlsx_sheet") return Promise.resolve(sheetData);
    return Promise.resolve(undefined);
  }),
}));

const sortButtons = (container: HTMLElement) =>
  container.querySelectorAll<HTMLElement>('button[title^="クリック: ソート"]');
const shownRowNumbers = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".absolute.top-0.left-0 > div:first-child")).map((el) => el.textContent);

async function renderViewer(tabId: string) {
  const view = render(<XlsxViewer tabId={tabId} filePath="/book.xlsx" />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  return view;
}

beforeEach(() => {
  useXlsxStore.setState({ tabs: {} });
  sheetData = sheet([["hello", "world"]]);
  brokenSheet = null;
  // jsdom にはレイアウトが無いので、スクロール領域を 1200x600 の画面として扱わせる
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
});
afterEach(() => vi.restoreAllMocks());

describe("XlsxViewer のシート切り替え", () => {
  it("読み込みに失敗したシートから、シートタブで別のシートに戻れる", async () => {
    brokenSheet = "Broken";
    await renderViewer("t1");

    await act(async () => {
      fireEvent.click(screen.getByText("Broken"));
    });
    expect(useXlsxStore.getState().tabs.t1.error).toContain("sheet is corrupted");

    await act(async () => {
      fireEvent.click(screen.getByText("Sheet1"));
    });
    expect(useXlsxStore.getState().tabs.t1.error).toBeNull();
    expect(useXlsxStore.getState().tabs.t1.activeSheetName).toBe("Sheet1");
  });
});

describe("XlsxViewer の行番号", () => {
  it("並べ替えても各行に元の行番号を表示する", async () => {
    sheetData = sheet([["b"], ["a"], ["c"]]);
    const { container } = await renderViewer("t2");
    expect(shownRowNumbers(container)).toEqual(["1", "2", "3"]);

    await act(async () => {
      fireEvent.click(sortButtons(container)[0]);
    });

    // 昇順は a (2 行目), b (1 行目), c (3 行目)
    expect(shownRowNumbers(container)).toEqual(["2", "1", "3"]);
  });
});

describe("XlsxViewer の列数の上限", () => {
  it("読み込んだ列だけを表示し、切り詰めたことを知らせる", async () => {
    sheetData = sheet([["a", "b"]], { total_cols: 5000, loaded_cols: 2 });
    const { container } = await renderViewer("t3");

    expect(sortButtons(container)).toHaveLength(2);
    expect(container.textContent).toContain("先頭 1 行 × 2 列を表示（全 1 行 × 5,000 列）");
  });
});

describe("XlsxViewer の再読み込み", () => {
  const requestedSheets = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "read_xlsx_sheet")
      .map(([, args]) => (args as { sheetName: string }).sheetName);
  };

  it("表示中のシート・並べ替え・絞り込み・列幅を引き継ぐ", async () => {
    const keepOnly = { column: "B", column_index: 1, filter_type: "contains", value: "keep" } as const;
    sheetData = sheet([["b", "keep"], ["a", "keep"]]);
    const first = await renderViewer("r1");
    await act(async () => {
      fireEvent.click(screen.getByText("Broken"));
    });
    await act(async () => {
      fireEvent.click(sortButtons(first.container)[0]);
    });
    act(() => {
      useXlsxStore.getState().setFilters("r1", [keepOnly]);
      useXlsxStore.getState().setColumnWidth("r1", 0, 321);
    });
    expect(useXlsxStore.getState().tabs.r1).toMatchObject({
      activeSheetName: "Broken",
      sort: { columnIndex: 0, direction: "asc" },
    });

    // ファイルが外部で変更され、再読み込みでビューアがマウントし直される
    first.unmount();
    sheetData = sheet([["b", "keep"], ["a", "keep"], ["c", "drop"]]);
    const second = await renderViewer("r1");

    expect((await requestedSheets()).pop()).toBe("Broken");
    expect(useXlsxStore.getState().tabs.r1).toMatchObject({
      activeSheetName: "Broken",
      sort: { columnIndex: 0, direction: "asc" },
      filters: [keepOnly],
      columnWidths: { 0: 321 },
    });
    // 読み直した 3 行のうち絞り込みに合う 2 行が、並べ替えた順 (a, b = 元の 2, 1 行目) で表示される
    expect(shownRowNumbers(second.container)).toEqual(["2", "1"]);
  });

  it("引き継いだシートがファイルから無くなっていたら先頭のシートを開き、並べ替えと絞り込みは外す", async () => {
    useXlsxStore.getState().initTab("r2");
    useXlsxStore.setState((state) => ({
      tabs: {
        ...state.tabs,
        r2: {
          ...state.tabs.r2,
          activeSheetName: "Removed",
          sort: { columnIndex: 1, direction: "desc" },
          filters: [{ column: "B", column_index: 1, filter_type: "contains", value: "x" }],
        },
      },
    }));

    await renderViewer("r2");

    expect((await requestedSheets()).pop()).toBe("Sheet1");
    expect(useXlsxStore.getState().tabs.r2).toMatchObject({ activeSheetName: "Sheet1", sort: null, filters: [] });
  });

  it("列が減って当てはまらなくなった並べ替えと絞り込みは外す", async () => {
    sheetData = sheet([["b", "x"], ["a", "y"]]);
    const first = await renderViewer("r3");
    await act(async () => {
      fireEvent.click(sortButtons(first.container)[1]);
    });
    act(() =>
      useXlsxStore.getState().setFilters("r3", [{ column: "B", column_index: 1, filter_type: "contains", value: "x" }])
    );

    first.unmount();
    sheetData = sheet([["b"], ["a"]]);
    await renderViewer("r3");

    expect(useXlsxStore.getState().tabs.r3).toMatchObject({ activeSheetName: "Sheet1", sort: null, filters: [] });
  });
});


describe("XlsxViewer の再読み込みとスクロール位置", () => {
  const originalScrollTo = Element.prototype.scrollTo;
  beforeEach(() => {
    // jsdom は scrollTo を実装していない。ブラウザと同じく、指定された軸の位置だけを動かす
    Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
      if (typeof options !== "object") return;
      if (options.top != null) this.scrollTop = options.top;
      if (options.left != null) this.scrollLeft = options.left;
    } as Element["scrollTo"];
    sheetData = sheet(Array.from({ length: 200 }, (_, i) => [`a${i}`, `b${i}`]));
  });
  afterEach(() => {
    Element.prototype.scrollTo = originalScrollTo;
  });

  const position = (container: HTMLElement) => {
    const el = container.querySelector<HTMLElement>(".overflow-auto.relative");
    return el && { top: el.scrollTop, left: el.scrollLeft };
  };
  function scrollTable(container: HTMLElement, to: { top: number; left: number }) {
    const el = container.querySelector<HTMLElement>(".overflow-auto.relative")!;
    el.scrollTop = to.top;
    el.scrollLeft = to.left;
    fireEvent.scroll(el);
  }
  const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  const scrolled = { top: 2800, left: 60 };

  it("同じシートを読み直したときは、スクロール位置を引き継ぐ", async () => {
    const view = render(<XlsxViewer key="before" tabId="s1" filePath="/book.xlsx" />);
    await settle();
    act(() => scrollTable(view.container, scrolled));

    // ファイルが外部で変更され、再読み込みでビューアが作り直される (ViewerArea が key を変える)
    view.rerender(<XlsxViewer key="after" tabId="s1" filePath="/book.xlsx" />);
    await settle();

    expect(position(view.container)).toEqual(scrolled);
  });

  it("別のシートに切り替えたら先頭から表示し、再読み込みでも前のシートの位置に戻さない", async () => {
    const view = render(<XlsxViewer key="before" tabId="s2" filePath="/book.xlsx" />);
    await settle();
    act(() => scrollTable(view.container, scrolled));

    await act(async () => {
      fireEvent.click(screen.getByText("Broken"));
    });
    await settle();
    expect(position(view.container)).toEqual({ top: 0, left: 0 });

    view.rerender(<XlsxViewer key="after" tabId="s2" filePath="/book.xlsx" />);
    await settle();
    expect(useXlsxStore.getState().tabs.s2.activeSheetName).toBe("Broken");
    expect(position(view.container)).toEqual({ top: 0, left: 0 });
  });

  it("引き継いだシートがファイルから無くなっていたら、先頭のシートを先頭から表示する", async () => {
    const view = render(<XlsxViewer key="before" tabId="s3" filePath="/book.xlsx" />);
    await settle();
    act(() => scrollTable(view.container, scrolled));
    // 表示していたシートの名前がファイル側で変わった
    act(() =>
      useXlsxStore.setState((state) => ({
        tabs: { ...state.tabs, s3: { ...state.tabs.s3, activeSheetName: "Removed" } },
      }))
    );

    view.rerender(<XlsxViewer key="after" tabId="s3" filePath="/book.xlsx" />);
    await settle();

    expect(useXlsxStore.getState().tabs.s3.activeSheetName).toBe("Sheet1");
    expect(position(view.container)).toEqual({ top: 0, left: 0 });
  });
});
