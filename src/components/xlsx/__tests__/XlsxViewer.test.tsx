import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { XlsxViewer } from "../XlsxViewer";
import { useXlsxStore } from "../../../stores/xlsxStore";

const cell = (v: string) => ({ value: v, raw: v, cell_type: "string", format_code: null });

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
let brokenSheet: string | null = null;
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
    if (cmd === "read_xlsx_sheet")
      return Promise.resolve({
        name: "Sheet1",
        rows: [[cell("hello"), cell("world")]],
        total_rows: 1,
        total_cols: 2,
        loaded_cols: 2,
        freeze_pane: { rows: 0, cols: 0 },
      });
    return Promise.resolve(undefined);
  }),
}));

beforeEach(() => useXlsxStore.setState({ tabs: {} }));

describe("XlsxViewer", () => {
  it("開いてもストアのタブ状態を消し続けず、シートを読み込める", async () => {
    let removeCalls = 0;
    const realRemove = useXlsxStore.getState().removeTab;
    useXlsxStore.setState({ removeTab: (id: string) => { removeCalls++; realRemove(id); } });

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<XlsxViewer tabId="t1" filePath="/book.xlsx" />);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(removeCalls).toBe(0);
    expect(useXlsxStore.getState().tabs.t1?.sheetData?.name).toBe("Sheet1");
    expect(view?.container.textContent).toContain("Sheet1");

    // タブ切替でアンマウントしても表示状態は残す (タブを閉じたときに tabActions が消す)
    view?.unmount();
    expect(removeCalls).toBe(0);
    expect(useXlsxStore.getState().tabs.t1?.activeSheetName).toBe("Sheet1");
  });

  it("タブを切り替えて戻ると、前に表示していたシートを開く", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const first = render(<XlsxViewer tabId="t3" filePath="/book.xlsx" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => { fireEvent.click(screen.getByText("Broken")); });
    first.unmount();

    vi.mocked(invoke).mockClear();
    render(<XlsxViewer tabId="t3" filePath="/book.xlsx" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(vi.mocked(invoke).mock.calls.find((c) => c[0] === "read_xlsx_sheet")?.[1]).toMatchObject({ sheetName: "Broken" });
    expect(useXlsxStore.getState().tabs.t3.activeSheetName).toBe("Broken");
  });
});

describe("XlsxViewer のシート切り替え", () => {
  it("読み込みに失敗したシートから、シートタブで別のシートに戻れる", async () => {
    brokenSheet = "Broken";
    render(<XlsxViewer tabId="t2" filePath="/book.xlsx" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    await act(async () => { fireEvent.click(screen.getByText("Broken")); });
    expect(useXlsxStore.getState().tabs.t2.error).toContain("sheet is corrupted");

    await act(async () => { fireEvent.click(screen.getByText("Sheet1")); });
    expect(useXlsxStore.getState().tabs.t2.error).toBeNull();
    expect(useXlsxStore.getState().tabs.t2.activeSheetName).toBe("Sheet1");
    brokenSheet = null;
  });
});
