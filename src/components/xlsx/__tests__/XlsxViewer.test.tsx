import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { XlsxViewer } from "../XlsxViewer";
import { useXlsxStore } from "../../../stores/xlsxStore";
import type { XlsxInfo, XlsxSheetData } from "../../../types";

const mockInfo: XlsxInfo = {
  sheets: [{ name: "Sheet1", index: 0 }],
  active_sheet_index: 0,
};

const mockSheetData: XlsxSheetData = {
  name: "Sheet1",
  rows: [
    [
      { value: "Name", raw: "Name", cell_type: "string", format_code: null },
      { value: "Age", raw: "Age", cell_type: "string", format_code: null },
    ],
    [
      { value: "Alice", raw: "Alice", cell_type: "string", format_code: null },
      { value: "30", raw: "30", cell_type: "number", format_code: null },
    ],
  ],
  total_rows: 2,
  total_cols: 2,
  freeze_pane: { rows: 1, cols: 0 },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "read_xlsx") return mockInfo;
    if (cmd === "read_xlsx_sheet") return mockSheetData;
    throw new Error(`unexpected command: ${cmd}`);
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

beforeEach(() => {
  useXlsxStore.setState({ tabs: {} });
});

describe("XlsxViewer", () => {
  it("does not enter an infinite removeTab loop on mount", async () => {
    const removeTab = vi.spyOn(useXlsxStore.getState(), "removeTab");

    render(<XlsxViewer tabId="t1" filePath="/test.xlsx" />);

    await waitFor(() => {
      expect(screen.getByText("Sheet1")).toBeInTheDocument();
    });

    // Bug #1: selector-less store subscription re-ran cleanup on every update,
    // calling removeTab dozens of times and blanking the window.
    expect(removeTab).not.toHaveBeenCalled();
  });

  it("renders sheet tabs after successful load", async () => {
    render(<XlsxViewer tabId="t2" filePath="/test.xlsx" />);
    expect(await screen.findByText("Sheet1")).toBeInTheDocument();
  });

  it("shows error state when loading fails", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));

    render(<XlsxViewer tabId="t3" filePath="/bad.xlsx" />);
    expect(await screen.findByText(/エラー:/)).toBeInTheDocument();
  });
});
