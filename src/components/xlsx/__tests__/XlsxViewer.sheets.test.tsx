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
