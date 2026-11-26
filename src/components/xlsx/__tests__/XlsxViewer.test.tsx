import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { XlsxViewer } from "../XlsxViewer";
import { useXlsxStore } from "../../../stores/xlsxStore";

const cell = (v: string) => ({ value: v, raw: v, cell_type: "string", format_code: null });

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "read_xlsx") return Promise.resolve({ sheets: [{ name: "Sheet1", index: 0 }], active_sheet_index: 0 });
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

    view?.unmount();
    expect(removeCalls).toBe(1);
    expect(useXlsxStore.getState().tabs.t1).toBeUndefined();
  });
});
