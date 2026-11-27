import { describe, it, expect } from "vitest";
import { compareCellValues, compareForSort, tryParseEntireNumber } from "../lib/compareCellValues";
import cases from "../../src-tauri/tests/fixtures/sort-cases.json";

// Rust 側 (csv_commands.rs) も同じ sort-cases.json を読む。CSV は Rust、XLSX はここで並べ替えるので、規則を揃える
describe("並べ替えの規則 (Rust と共通の sort-cases.json)", () => {
  it("桁区切り・通貨記号・% を含む数値を読み、数値でないものは読まない", () => {
    const actual = (cases.numbers as [string, number | null][]).map(([text]) => [text, tryParseEntireNumber(text)]);
    expect(actual).toEqual(cases.numbers);
  });

  it.each(cases.sorts)("$name", ({ input, asc, desc }) => {
    expect([...input].sort((a, b) => compareForSort(a, b, "asc"))).toEqual(asc);
    expect([...input].sort((a, b) => compareForSort(a, b, "desc"))).toEqual(desc);
  });
});

describe("compareCellValues の順序", () => {
  const values = ["2", "10", "1x", "", "-3", "abc", "1,234", "7.5", "3", "20", "2x", "1", "¥5", "50%"];

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
});
