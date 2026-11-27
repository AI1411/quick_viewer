import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VirtualTable, ROW_HEIGHT } from "../VirtualTable";
import type { ScrollPosition } from "../../../types";

const noop = () => {};

/** jsdom は scrollTo を実装していない。ブラウザと同じく、指定された軸の位置だけを動かす */
function scrollToLikeBrowser(this: Element, options?: ScrollToOptions | number) {
  if (typeof options !== "object") return;
  if (options.top != null) this.scrollTop = options.top;
  if (options.left != null) this.scrollLeft = options.left;
}

function renderTable(columns: number, pinnedCount = 0) {
  const headers = Array.from({ length: columns }, (_, i) => `col${i}`);
  return render(
    <VirtualTable
      headers={headers}
      rows={[headers.map((_, i) => `v${i}`)]}
      totalRows={1}
      columnWidths={{}}
      sort={null}
      pinnedCount={pinnedCount}
      selectedAnchor={null}
      selectedFocus={null}
      onSort={noop}
      onColumnResize={noop}
      onCellClick={noop}
      frozenRows={[headers.map((_, i) => `f${i}`)]}
      frozenRowCount={1}
    />
  );
}

describe("VirtualTable の列の仮想化", () => {
  // jsdom にはレイアウトが無いので、スクロール領域を 1200x600 の画面として扱わせる
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  });
  afterEach(() => vi.restoreAllMocks());

  it("数万列あっても全列の DOM を作らない", () => {
    const { container } = renderTable(20_000);
    const headerButtons = container.querySelectorAll('button[title^="クリック: ソート"]');
    expect(headerButtons.length).toBeGreaterThan(0);
    expect(headerButtons.length).toBeLessThan(100);
    // 横スクロール幅は全列分を確保する
    const header = container.querySelector(".sticky.top-0") as HTMLElement;
    expect(header.style.minWidth).toBe(`${52 + 20_000 * 120}px`);
  });

  it("rowNumbers を渡すと並べ替え後も元の行番号を表示する", () => {
    const { container } = render(
      <VirtualTable
        headers={["n"]}
        rows={[["c"], ["a"], ["b"]]}
        rowNumbers={[3, 1, 2]}
        totalRows={3}
        columnWidths={{}}
        sort={null}
        pinnedCount={0}
        selectedAnchor={null}
        selectedFocus={null}
        onSort={noop}
        onColumnResize={noop}
        onCellClick={noop}
      />
    );
    const numbers = Array.from(container.querySelectorAll(".absolute.top-0.left-0 > div:first-child")).map(
      (el) => el.textContent
    );
    expect(numbers).toEqual(["3", "1", "2"]);
  });

  it("ピン留め列は表示範囲に関係なく描画する", () => {
    const { container } = renderTable(20_000, 2);
    const text = container.textContent ?? "";
    expect(text).toContain("col0");
    expect(text).toContain("col1");
    expect(text).toContain("f1");
  });
});

describe("VirtualTable のスクロール位置", () => {
  const originalScrollTo = Element.prototype.scrollTo;
  beforeEach(() => {
    Element.prototype.scrollTo = scrollToLikeBrowser as Element["scrollTo"];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  });
  afterEach(() => {
    Element.prototype.scrollTo = originalScrollTo;
    vi.restoreAllMocks();
  });

  function renderRows(props: { initialScroll?: ScrollPosition; onScrollKeep?: (position: ScrollPosition) => void }) {
    const view = render(
      <VirtualTable
        headers={["n"]}
        rows={Array.from({ length: 1000 }, (_, i) => [`v${i}`])}
        totalRows={1000}
        columnWidths={{}}
        sort={null}
        pinnedCount={0}
        selectedAnchor={null}
        selectedFocus={null}
        onSort={noop}
        onColumnResize={noop}
        onCellClick={noop}
        {...props}
      />
    );
    return { ...view, scroller: view.container.firstElementChild as HTMLElement };
  }
  const shownRowNumbers = (container: HTMLElement) =>
    Array.from(container.querySelectorAll(".absolute.top-0.left-0 > div:first-child")).map((el) => el.textContent);

  it("initialScroll の位置までスクロールし、その位置の行から描画する", () => {
    const { container, scroller } = renderRows({ initialScroll: { top: 500 * ROW_HEIGHT, left: 40 } });

    expect(scroller.scrollTop).toBe(500 * ROW_HEIGHT);
    expect(scroller.scrollLeft).toBe(40);
    expect(shownRowNumbers(container)).toContain("501");
    expect(shownRowNumbers(container)).not.toContain("1");
  });

  it("画面から外れるときに、最後にスクロールした位置を渡す", () => {
    const onScrollKeep = vi.fn();
    const { scroller, unmount } = renderRows({ onScrollKeep });

    for (const top of [140, 280]) {
      scroller.scrollTop = top;
      scroller.scrollLeft = 60;
      fireEvent.scroll(scroller);
    }
    expect(onScrollKeep).not.toHaveBeenCalled();

    unmount();
    expect(onScrollKeep.mock.calls).toEqual([[{ top: 280, left: 60 }]]);
  });

  it("一度もスクロールしていなければ、最初の位置を渡す", () => {
    const onScrollKeep = vi.fn();
    const { unmount } = renderRows({ initialScroll: { top: 280, left: 60 }, onScrollKeep });

    unmount();
    expect(onScrollKeep.mock.calls).toEqual([[{ top: 280, left: 60 }]]);
  });
});
