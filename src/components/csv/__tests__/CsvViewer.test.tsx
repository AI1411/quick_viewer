import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

const TOTAL = 250;
const allRows = Array.from({ length: TOTAL }, (_, i) => [String(TOTAL - i)]);
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const meta = { total_rows: TOTAL, columns: 1, encoding: "UTF-8", delimiter: ",", headers: ["n"] };
    if (cmd === "read_csv") {
      return Promise.resolve({ headers: ["n"], rows: allRows.slice(0, args.limit as number), meta });
    }
    if (cmd === "read_csv_chunk") {
      const offset = args.offset as number;
      const rows = allRows.slice(offset, offset + (args.limit as number));
      return Promise.resolve({ headers: ["n"], rows, offset, total_rows: TOTAL });
    }
    return Promise.resolve(undefined);
  }),
}));

import { CsvViewer } from "../CsvViewer";
import { useCsvStore } from "../../../stores/csvStore";

beforeEach(() => {
  calls.length = 0;
  useCsvStore.setState({ tabs: {} });
});

describe("CsvViewer の並べ替え", () => {
  it("読み込み途中でも、並べ替えると残りの行を読み込んで全行を対象にする", async () => {
    render(<CsvViewer tabId="t1" filePath="/data.csv" />);
    await act(async () => {});
    expect(useCsvStore.getState().tabs.t1.loadedRows).toBe(100);

    await act(async () => {
      useCsvStore.getState().setSort("t1", { columnIndex: 0, direction: "asc" });
    });

    const chunk = calls.find((c) => c.cmd === "read_csv_chunk");
    expect(chunk?.args).toMatchObject({ offset: 100, limit: 150 });
    expect(useCsvStore.getState().tabs.t1.loadedRows).toBe(TOTAL);
  });
});
