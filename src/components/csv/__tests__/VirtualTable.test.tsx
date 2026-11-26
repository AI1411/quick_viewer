import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { VirtualTable } from "../VirtualTable";

const noop = () => {};

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
