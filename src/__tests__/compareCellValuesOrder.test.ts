import { describe, it, expect } from "vitest";
import { compareCellValues } from "../lib/compareCellValues";

describe("compareCellValues の順序", () => {
  const values = ["2", "10", "1x", "", "-3", "abc", "1,234", "7.5", "3", "20", "2x", "1"];

  it("数値と文字列が混ざっても順序が循環しない", () => {
    // 2 < 10 (数値) と 10 < "1x" < 2 (文字列) が同時に成り立つと、並べ替えの結果が入力の並びに左右される
    const cycles: string[] = [];
    for (const a of values) {
      for (const b of values) {
        for (const c of values) {
          if (compareCellValues(a, b) < 0 && compareCellValues(b, c) < 0 && compareCellValues(a, c) >= 0) {
            cycles.push(`${a} < ${b} < ${c} なのに ${a} >= ${c}`);
          }
        }
      }
    }
    expect(cycles).toEqual([]);
  });

  it("数値は数値どうしで大小順に並び、文字列はその後ろに来る (Rust の compare_cell_values と同じ)", () => {
    expect(["1x", "10", "abc", "2", ""].sort(compareCellValues)).toEqual(["2", "10", "", "1x", "abc"]);
  });
});
