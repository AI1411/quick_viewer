import { describe, it, expect } from "vitest";
import { compareCells, parseNumericCell, sortByColumn } from "../lib/tableSort";

const sortValues = (values: string[], dir: "asc" | "desc" = "asc") => sortByColumn(values, (v) => v, dir);

describe("parseNumericCell", () => {
  it("桁区切り・通貨記号・% を含む数値を読む", () => {
    expect(parseNumericCell("1,234")).toBe(1234);
    expect(parseNumericCell("¥1,200")).toBe(1200);
    expect(parseNumericCell("-3.5%")).toBe(-3.5);
    expect(parseNumericCell("1e3")).toBe(1000);
    expect(parseNumericCell("12abc")).toBeNull();
    expect(parseNumericCell("2024-01-01")).toBeNull();
  });
});

describe("sortByColumn", () => {
  it("CSV の桁区切りの数値を数値として並べる", () => {
    expect(sortValues(["1,234", "999", "12,000"])).toEqual(["999", "1,234", "12,000"]);
  });

  it("XLSX の小数と負数を数値として並べる (localeCompare numeric では 1.5 < 1.25 になっていた)", () => {
    expect(sortValues(["1.5", "1.25", "-2", "10", "-10"])).toEqual(["-10", "-2", "1.25", "1.5", "10"]);
  });

  it("数値と文字列が混ざっても順序が矛盾せず、空セルは常に末尾", () => {
    expect(sortValues(["b", "", "10", "a", "2"])).toEqual(["2", "10", "a", "b", ""]);
    expect(sortValues(["b", "", "10", "a", "2"], "desc")).toEqual(["b", "a", "10", "2", ""]);
    expect(Math.sign(compareCells("10", "a"))).toBe(-Math.sign(compareCells("a", "10")));
  });

  it("ISO 形式の日付は文字列の順で時系列になる", () => {
    expect(sortValues(["2024-03-01", "2023-12-31", "2024-01-15"])).toEqual(["2023-12-31", "2024-01-15", "2024-03-01"]);
  });
});
