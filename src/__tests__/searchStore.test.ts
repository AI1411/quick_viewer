import { describe, it, expect, beforeEach } from "vitest";
import { useSearchStore } from "../stores/searchStore";

const defaultState = {
  isOpen: false,
  query: "",
  options: { useRegex: false, caseSensitive: false },
  matchCount: 0,
  currentMatchIndex: 0,
  cellMatches: [] as { row: number; col: number }[],
  pdfMatches: [] as { pageIndex: number; matchIndexOnPage: number }[],
};

describe("searchStore", () => {
  beforeEach(() => {
    useSearchStore.setState(defaultState);
  });

  it("setOpen でオーバーレイが開閉する", () => {
    useSearchStore.getState().setOpen(true);
    expect(useSearchStore.getState().isOpen).toBe(true);
    useSearchStore.getState().setOpen(false);
    expect(useSearchStore.getState().isOpen).toBe(false);
  });

  it("setQuery でクエリが更新され currentMatchIndex がリセットされる", () => {
    useSearchStore.setState({ currentMatchIndex: 3, matchCount: 10 });
    useSearchStore.getState().setQuery("hello");
    expect(useSearchStore.getState().query).toBe("hello");
    expect(useSearchStore.getState().currentMatchIndex).toBe(0);
  });

  it("setCellMatches でマッチが設定され matchCount も更新される", () => {
    const matches = [{ row: 0, col: 0 }, { row: 1, col: 2 }];
    useSearchStore.getState().setCellMatches(matches);
    expect(useSearchStore.getState().cellMatches).toHaveLength(2);
    expect(useSearchStore.getState().matchCount).toBe(2);
    expect(useSearchStore.getState().currentMatchIndex).toBe(0);
  });

  it("setPdfMatches で PDF マッチが設定され matchCount も更新される", () => {
    const matches = [
      { pageIndex: 0, matchIndexOnPage: 0 },
      { pageIndex: 2, matchIndexOnPage: 1 },
    ];
    useSearchStore.getState().setPdfMatches(matches);
    expect(useSearchStore.getState().pdfMatches).toHaveLength(2);
    expect(useSearchStore.getState().matchCount).toBe(2);
    expect(useSearchStore.getState().currentMatchIndex).toBe(0);
  });

  it("nextMatch で次のインデックスに進む（循環）", () => {
    useSearchStore.setState({ matchCount: 3, currentMatchIndex: 2 });
    useSearchStore.getState().nextMatch();
    expect(useSearchStore.getState().currentMatchIndex).toBe(0);
  });

  it("prevMatch で前のインデックスに戻る（循環）", () => {
    useSearchStore.setState({ matchCount: 3, currentMatchIndex: 0 });
    useSearchStore.getState().prevMatch();
    expect(useSearchStore.getState().currentMatchIndex).toBe(2);
  });

  it("matchCount が 0 のとき nextMatch/prevMatch は何もしない", () => {
    useSearchStore.setState({ matchCount: 0, currentMatchIndex: 0 });
    useSearchStore.getState().nextMatch();
    expect(useSearchStore.getState().currentMatchIndex).toBe(0);
  });

  it("close でクエリとマッチがクリアされ isOpen が false になる", () => {
    useSearchStore.setState({
      isOpen: true,
      query: "test",
      cellMatches: [{ row: 0, col: 0 }],
      pdfMatches: [{ pageIndex: 1, matchIndexOnPage: 0 }],
      matchCount: 1,
    });
    useSearchStore.getState().close();
    expect(useSearchStore.getState().isOpen).toBe(false);
    expect(useSearchStore.getState().query).toBe("");
    expect(useSearchStore.getState().cellMatches).toHaveLength(0);
    expect(useSearchStore.getState().pdfMatches).toHaveLength(0);
    expect(useSearchStore.getState().matchCount).toBe(0);
  });
});
