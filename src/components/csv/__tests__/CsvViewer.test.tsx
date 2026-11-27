import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { FilterCondition } from "../../../types";

// Rust 側のコマンドの代わり。ファイル全体 (table.rows) を対象に絞り込み・並べ替えをする
const table = { headers: [] as string[], rows: [] as string[][] };
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

function useTable(headers: string[], rows: string[][]) {
  table.headers = headers;
  table.rows = rows;
}

function matching(conditions: FilterCondition[] | null) {
  return table.rows
    .map((row, source) => ({ row, source }))
    .filter(({ row }) => (conditions ?? []).every((c) => row[c.column_index ?? -1]?.includes(c.value)));
}

function csvData(entries: Array<{ row: string[]; source: number }>, withSourceRows: boolean) {
  return {
    headers: table.headers,
    rows: entries.map((e) => e.row),
    meta: {
      total_rows: entries.length,
      columns: table.headers.length,
      encoding: "UTF-8",
      delimiter: ",",
      headers: table.headers,
    },
    ...(withSourceRows ? { source_rows: entries.map((e) => e.source) } : {}),
  };
}

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    const conditions = (args.conditions ?? null) as FilterCondition[] | null;
    if (cmd === "read_csv") {
      const all = csvData(matching(null), false);
      return Promise.resolve({ ...all, rows: all.rows.slice(0, args.limit as number) });
    }
    if (cmd === "read_csv_chunk") {
      const offset = args.offset as number;
      const rows = table.rows.slice(offset, offset + (args.limit as number));
      return Promise.resolve({ headers: table.headers, rows, offset, total_rows: table.rows.length });
    }
    if (cmd === "filter_csv") {
      return Promise.resolve(csvData(matching(conditions), (conditions ?? []).length > 0));
    }
    if (cmd === "sort_csv") {
      const sign = args.ascending ? 1 : -1;
      const sorted = matching(conditions).sort((a, b) => sign * (Number(a.row[0]) - Number(b.row[0])));
      return Promise.resolve(csvData(sorted, true));
    }
    return Promise.resolve([]);
  }),
}));

import { CsvViewer } from "../CsvViewer";
import { useCsvStore } from "../../../stores/csvStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useSearchStore } from "../../../stores/searchStore";

const TOTAL = 250;
/** 1 列だけの表。値は 250, 249, ..., 1 の順 */
const descendingNumbers = () => Array.from({ length: TOTAL }, (_, i) => [String(TOTAL - i)]);

const sortButtons = (container: HTMLElement) =>
  container.querySelectorAll<HTMLElement>('button[title^="クリック: ソート"]');
const filterButtons = (container: HTMLElement) =>
  container.querySelectorAll<HTMLElement>('button[title="フィルタ"]');
const shownRowNumbers = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".absolute.top-0.left-0 > div:first-child")).map((el) => el.textContent);

async function applyFilter(container: HTMLElement, columnIndex: number, value: string) {
  fireEvent.click(filterButtons(container)[columnIndex]);
  fireEvent.change(screen.getByPlaceholderText("値を入力..."), { target: { value } });
  await act(async () => {
    fireEvent.click(screen.getByText("適用"));
  });
}

beforeEach(() => {
  calls.length = 0;
  useCsvStore.setState({ tabs: {} });
  // jsdom にはレイアウトが無いので、スクロール領域を 1200x600 の画面として扱わせる
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
});
afterEach(() => {
  vi.restoreAllMocks();
  useSearchStore.getState().close();
  // Tauri はコマンドの引数名を camelCase で受け取る。snake_case のキーは届かず、必須の引数なら実行時に失敗する
  for (const { cmd, args } of calls) {
    expect(Object.keys(args).filter((key) => key.includes("_")), `${cmd} の引数名`).toEqual([]);
  }
});

describe("CsvViewer の行番号", () => {
  it("読み込み途中で並べ替えても、ファイル全体を並べ替えて元ファイルの行番号を表示する", async () => {
    useTable(["n"], descendingNumbers());
    const { container } = render(<CsvViewer tabId="t1" filePath="/data.csv" />);
    await act(async () => {});
    expect(useCsvStore.getState().tabs.t1.loadedRows).toBe(100);

    await act(async () => {
      fireEvent.click(sortButtons(container)[0]);
    });

    await waitFor(() => expect(useCsvStore.getState().tabs.t1.sortedRows).toHaveLength(TOTAL));
    expect(calls.find((c) => c.cmd === "sort_csv")?.args).toMatchObject({ columnIndex: 0, ascending: true });
    // 昇順の先頭 "1" は元の 250 行目、次の "2" は 249 行目
    expect(shownRowNumbers(container).slice(0, 2)).toEqual(["250", "249"]);
  });

  it("絞り込んだ行にも元ファイルの行番号を表示する", async () => {
    useTable(["n"], descendingNumbers());
    const { container } = render(<CsvViewer tabId="t2" filePath="/data.csv" />);
    await act(async () => {});

    await applyFilter(container, 0, "25");

    // "25" を含むのは 250 (1 行目), 225 (26 行目), 125 (126 行目), 25 (226 行目)
    await waitFor(() => expect(shownRowNumbers(container)).toEqual(["1", "26", "126", "226"]));
  });
});

describe("CsvViewer の検索", () => {
  it("検索の指定と現在の並べ替えを search_csv に渡す", async () => {
    useTable(["n"], descendingNumbers());
    const { container } = render(<CsvViewer tabId="t6" filePath="/data.csv" />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(sortButtons(container)[0]);
    });
    await waitFor(() => expect(useCsvStore.getState().tabs.t6.sortedRows).toHaveLength(TOTAL));

    await act(async () => {
      useSearchStore.setState({ isOpen: true, query: "^25", options: { useRegex: true, caseSensitive: true } });
    });

    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "search_csv")?.args).toMatchObject({
        query: "^25",
        useRegex: true,
        caseSensitive: true,
        sortColumnIndex: 0,
        sortAscending: true,
      })
    );
  });
});

describe("CsvViewer の同じ名前の列のフィルタ", () => {
  it("片方の列の条件を解除しても、同じ名前のもう片方の条件は残る", async () => {
    useTable(["v", "v"], Array.from({ length: 30 }, (_, i) => [String(i), String(i % 3)]));
    const { container } = render(<CsvViewer tabId="t3" filePath="/data.csv" />);
    await act(async () => {});

    await applyFilter(container, 1, "1");
    await applyFilter(container, 0, "2");
    await waitFor(() =>
      expect(useCsvStore.getState().tabs.t3.filters.map((f) => f.column_index)).toEqual([1, 0])
    );

    // フィルタのポップオーバーは、開いた列の条件を表示する
    fireEvent.click(filterButtons(container)[0]);
    expect(screen.getByPlaceholderText<HTMLInputElement>("値を入力...").value).toBe("2");
    fireEvent.keyDown(screen.getByPlaceholderText("値を入力..."), { key: "Escape" });

    await act(async () => {
      fireEvent.click(screen.getAllByLabelText("v フィルタを削除")[0]);
    });
    await waitFor(() =>
      expect(useCsvStore.getState().tabs.t3.filters.map((f) => [f.column_index, f.value])).toEqual([[0, "2"]])
    );
  });
});

describe("CsvViewer の既定の区切り文字", () => {
  afterEach(() => useSettingsStore.setState({ csvSettings: { defaultDelimiter: "auto" } }));

  it("設定の区切り文字で読み、以降の呼び出しにも同じ区切り文字を渡す", async () => {
    useTable(["n"], descendingNumbers());
    useSettingsStore.setState({ csvSettings: { defaultDelimiter: ";" } });
    const { container } = render(<CsvViewer tabId="t4" filePath="/data.csv" />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(sortButtons(container)[0]);
    });

    expect(calls.find((c) => c.cmd === "read_csv")?.args.delimiter).toBe(";");
    // 区切り文字が変わると Rust 側は別の索引を作るので、同じ値を渡し続ける
    await waitFor(() => expect(calls.find((c) => c.cmd === "sort_csv")?.args.delimiter).toBe(";"));
  });

  it("設定が auto のときは区切り文字を指定せず、自動判定に任せる", async () => {
    useTable(["n"], descendingNumbers());
    render(<CsvViewer tabId="t5" filePath="/data.csv" />);
    await act(async () => {});
    expect(calls.find((c) => c.cmd === "read_csv")?.args.delimiter).toBeNull();
  });
});
