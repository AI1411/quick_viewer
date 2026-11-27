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
import { ROW_HEIGHT } from "../VirtualTable";
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

describe("CsvViewer の再読み込み", () => {
  /** n 列と、行ごとに a / b が交互に入る kind 列 */
  const numbersWithKind = () => Array.from({ length: 6 }, (_, i) => [String(6 - i), i % 2 === 0 ? "a" : "b"]);
  const callsAfter = (start: number, cmd: string) => calls.slice(start).filter((c) => c.cmd === cmd);

  it("並べ替えと絞り込みを引き継ぎ、読み直したデータに適用し直す", async () => {
    useTable(["n", "kind"], numbersWithKind());
    const first = render(<CsvViewer tabId="r1" filePath="/data.csv" />);
    await act(async () => {});
    await applyFilter(first.container, 1, "a");
    await act(async () => {
      fireEvent.click(sortButtons(first.container)[0]);
    });
    await waitFor(() => expect(useCsvStore.getState().tabs.r1.sortedRows?.map((r) => r[0])).toEqual(["2", "4", "6"]));

    // ファイルが外部で変更され、再読み込みでビューアがマウントし直される
    first.unmount();
    useTable(["n", "kind"], [...numbersWithKind(), ["0", "a"]]);
    const mark = calls.length;
    render(<CsvViewer tabId="r1" filePath="/data.csv" />);

    await waitFor(() => expect(useCsvStore.getState().tabs.r1.sortedRows?.map((r) => r[0])).toEqual(["0", "2", "4", "6"]));
    const tab = useCsvStore.getState().tabs.r1;
    expect(tab.sort).toEqual({ columnIndex: 0, direction: "asc" });
    expect(tab.filters.map((f) => [f.column, f.column_index, f.value])).toEqual([["kind", 1, "a"]]);
    expect(callsAfter(mark, "sort_csv")[0].args).toMatchObject({ columnIndex: 0, ascending: true, conditions: tab.filters });
  });

  it("列が変わって当てはまらなくなった並べ替えと絞り込みは捨てる", async () => {
    useTable(["n", "kind"], numbersWithKind());
    const first = render(<CsvViewer tabId="r2" filePath="/data.csv" />);
    await act(async () => {});
    await applyFilter(first.container, 1, "a");
    await act(async () => {
      fireEvent.click(sortButtons(first.container)[1]);
    });
    await waitFor(() => expect(useCsvStore.getState().tabs.r2.sortedRows).not.toBeNull());

    first.unmount();
    useTable(["n"], descendingNumbers());
    const mark = calls.length;
    render(<CsvViewer tabId="r2" filePath="/data.csv" />);

    await waitFor(() => expect(useCsvStore.getState().tabs.r2.data?.headers).toEqual(["n"]));
    await act(async () => {});
    const tab = useCsvStore.getState().tabs.r2;
    expect(tab.sort).toBeNull();
    expect(tab.filters).toEqual([]);
    expect(tab.sortedRows).toBeNull();
    expect(callsAfter(mark, "sort_csv")).toEqual([]);
    expect(callsAfter(mark, "filter_csv")).toEqual([]);
  });

  it("適用し直しに失敗したら並べ替えと絞り込みを外し、全行を読める状態に戻す", async () => {
    useTable(["n"], descendingNumbers());
    const first = render(<CsvViewer tabId="r3" filePath="/data.csv" />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(sortButtons(first.container)[0]);
    });
    await waitFor(() => expect(useCsvStore.getState().tabs.r3.sortedRows).not.toBeNull());

    first.unmount();
    const { invoke } = await import("@tauri-apps/api/core");
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation((cmd, args) =>
      cmd === "sort_csv" ? Promise.reject("boom") : original(cmd, args)
    );
    render(<CsvViewer tabId="r3" filePath="/data.csv" />);

    await waitFor(() => expect(useCsvStore.getState().tabs.r3.sort).toBeNull());
    const tab = useCsvStore.getState().tabs.r3;
    expect(tab.sortedRows).toBeNull();
    expect(tab.isSorting).toBe(false);
    expect(tab.data?.rows.length).toBe(100);
    vi.mocked(invoke).mockImplementation(original);
  });
});

describe("CsvViewer の再読み込みとスクロール位置", () => {
  const originalScrollTo = Element.prototype.scrollTo;
  beforeEach(() => {
    // jsdom は scrollTo を実装していない。ブラウザと同じく、指定された軸の位置だけを動かす
    Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
      if (typeof options !== "object") return;
      if (options.top != null) this.scrollTop = options.top;
      if (options.left != null) this.scrollLeft = options.left;
    } as Element["scrollTo"];
  });
  afterEach(() => {
    Element.prototype.scrollTo = originalScrollTo;
  });

  const scroller = (container: HTMLElement) => container.querySelector<HTMLElement>(".overflow-auto.relative");
  const position = (container: HTMLElement) => {
    const el = scroller(container);
    return el && { top: el.scrollTop, left: el.scrollLeft };
  };
  function scrollTable(container: HTMLElement, to: { top: number; left: number }) {
    const el = scroller(container)!;
    el.scrollTop = to.top;
    el.scrollLeft = to.left;
    fireEvent.scroll(el);
  }
  const callsAfter = (start: number, cmd: string) => calls.slice(start).filter((c) => c.cmd === cmd);
  const at150 = { top: 150 * ROW_HEIGHT, left: 40 };

  it("スクロール位置を引き継ぎ、その位置の行までまとめて読み直す", async () => {
    useTable(["n"], descendingNumbers());
    const view = render(<CsvViewer key="before" tabId="s1" filePath="/data.csv" />);
    await act(async () => {});
    await act(async () => scrollTable(view.container, at150));
    await waitFor(() => expect(useCsvStore.getState().tabs.s1.loadedRows).toBeGreaterThan(150));

    // ファイルが外部で変更され、再読み込みでビューアが作り直される (ViewerArea が key を変える)
    const mark = calls.length;
    view.rerender(<CsvViewer key="after" tabId="s1" filePath="/data.csv" />);

    await waitFor(() => expect(position(view.container)).toEqual(at150));
    // 先頭の 100 行だけを読むと、150 行目が空のまま 200 行ずつの読み足しを待つことになる
    expect(callsAfter(mark, "read_csv").map((c) => c.args.limit)).toEqual([250]);
    expect(callsAfter(mark, "read_csv_chunk")).toEqual([]);
  });

  it("並べ替えを引き継ぐときは先頭の 100 行だけを読み直し、位置は引き継ぐ", async () => {
    useTable(["n"], descendingNumbers());
    const view = render(<CsvViewer key="before" tabId="s2" filePath="/data.csv" />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(sortButtons(view.container)[0]);
    });
    await waitFor(() => expect(useCsvStore.getState().tabs.s2.sortedRows).not.toBeNull());
    await act(async () => scrollTable(view.container, at150));

    const mark = calls.length;
    view.rerender(<CsvViewer key="after" tabId="s2" filePath="/data.csv" />);

    await waitFor(() => expect(useCsvStore.getState().tabs.s2.sortedRows?.length).toBe(TOTAL));
    expect(position(view.container)).toEqual(at150);
    // 並べ替えた結果が全行を返すので、並べ替え前のデータは読み足さない
    expect(callsAfter(mark, "read_csv").map((c) => c.args.limit)).toEqual([100]);
  });

  it("初めて開いたときは先頭から表示し、先頭の 100 行だけを読む", async () => {
    useTable(["n"], descendingNumbers());
    const view = render(<CsvViewer tabId="s3" filePath="/data.csv" />);
    await act(async () => {});

    expect(position(view.container)).toEqual({ top: 0, left: 0 });
    expect(calls.filter((c) => c.cmd === "read_csv").map((c) => c.args.limit)).toEqual([100]);
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

  it.each(["auto", ";"] as const)(
    ".tsv は設定 (%s) に関係なく、どの呼び出しでもタブ区切りとして読む",
    async (defaultDelimiter) => {
      useTable(["n"], descendingNumbers());
      useSettingsStore.setState({ csvSettings: { defaultDelimiter } });
      const { container } = render(<CsvViewer tabId="t6" filePath="/data.TSV" />);
      await act(async () => {});
      await act(async () => {
        fireEvent.click(sortButtons(container)[0]);
      });
      await waitFor(() => expect(calls.some((c) => c.cmd === "sort_csv")).toBe(true));

      // 区切り文字が呼び出しごとに違うと、Rust 側は別の索引を作ってしまう
      const delimiters = calls.filter((c) => "delimiter" in c.args).map((c) => [c.cmd, c.args.delimiter]);
      expect(delimiters.length).toBeGreaterThanOrEqual(2);
      expect(delimiters.filter(([, d]) => d !== "\t")).toEqual([]);
    }
  );

  it("設定が auto のときは区切り文字を指定せず、自動判定に任せる", async () => {
    useTable(["n"], descendingNumbers());
    render(<CsvViewer tabId="t5" filePath="/data.csv" />);
    await act(async () => {});
    expect(calls.find((c) => c.cmd === "read_csv")?.args.delimiter).toBeNull();
  });
});
