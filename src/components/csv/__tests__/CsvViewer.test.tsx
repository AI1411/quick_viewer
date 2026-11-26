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
import { useSettingsStore } from "../../../stores/settingsStore";

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

describe("CsvViewer の行番号", () => {
  it("並べ替えても各行に元ファイルの行番号を表示する", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);

    const { container } = render(<CsvViewer tabId="t2" filePath="/data.csv" />);
    await act(async () => {});
    await act(async () => {
      useCsvStore.getState().setSort("t2", { columnIndex: 0, direction: "asc" });
    });

    // 値は 250, 249, ..., 1 の順に並んでいるので、昇順の先頭 "1" は元の 250 行目
    const firstRowNumber = container.querySelector(".absolute.top-0.left-0 > div:first-child")?.textContent;
    expect(firstRowNumber).toBe("250");
    vi.restoreAllMocks();
  });
});

describe("CsvViewer の既定の区切り文字", () => {
  it("設定の区切り文字で読み、追加読み込みも同じ区切り文字を使う", async () => {
    useSettingsStore.setState({ csvSettings: { defaultDelimiter: ";" } });
    render(<CsvViewer tabId="t3" filePath="/data.csv" />);
    await act(async () => {});
    await act(async () => {
      useCsvStore.getState().setSort("t3", { columnIndex: 0, direction: "asc" });
    });
    expect(calls.find((c) => c.cmd === "read_csv")?.args.delimiter).toBe(";");
    // 2 回目以降は読み込み時に判定された区切り文字 (meta.delimiter) を渡す
    expect(calls.find((c) => c.cmd === "read_csv_chunk")?.args.delimiter).toBe(",");
    useSettingsStore.setState({ csvSettings: { defaultDelimiter: "auto" } });
  });
});
