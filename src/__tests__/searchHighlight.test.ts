import { describe, it, expect } from "vitest";
import { highlightTextNodes, clearSearchMarks } from "../lib/searchHighlight";
import type { SearchOptions } from "../stores/searchStore";

const opts: SearchOptions = { useRegex: false, caseSensitive: false };

function makeRoot(html: string): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

describe("highlightTextNodes", () => {
  it("テキストノードにマークを挿入する", () => {
    const root = makeRoot("hello world");
    const marks = highlightTextNodes(root, "world", opts);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("world");
    expect(root.innerHTML).toContain('<mark data-search-match="true">world</mark>');
  });

  it("大文字小文字を無視して検索する", () => {
    const root = makeRoot("Hello World");
    const marks = highlightTextNodes(root, "hello", opts);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("Hello");
  });

  it("大文字小文字を区別して検索する", () => {
    const root = makeRoot("Hello World hello");
    const marks = highlightTextNodes(root, "hello", { ...opts, caseSensitive: true });
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("hello");
  });

  it("正規表現で検索する", () => {
    const root = makeRoot("foo123bar456");
    const marks = highlightTextNodes(root, "\\d+", { ...opts, useRegex: true });
    expect(marks).toHaveLength(2);
  });

  it("クエリが空のとき何も変えない", () => {
    const root = makeRoot("hello world");
    const marks = highlightTextNodes(root, "", opts);
    expect(marks).toHaveLength(0);
    expect(root.innerHTML).toBe("hello world");
  });

  it("無効な正規表現のとき空配列を返す", () => {
    const root = makeRoot("hello world");
    const marks = highlightTextNodes(root, "[invalid", { ...opts, useRegex: true });
    expect(marks).toHaveLength(0);
  });
});

describe("clearSearchMarks", () => {
  it("mark 要素を削除してテキストに戻す", () => {
    const root = makeRoot('hello <mark data-search-match="true">world</mark> foo');
    clearSearchMarks(root);
    expect(root.querySelectorAll("mark[data-search-match]")).toHaveLength(0);
    expect(root.textContent).toBe("hello world foo");
  });
});
