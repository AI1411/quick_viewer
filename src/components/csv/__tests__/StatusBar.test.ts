import { describe, it, expect } from "vitest";
import { computeStats } from "../StatusBar";

describe("computeStats", () => {
  const rows = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
  ];

  it("1x1 セル選択: 単一数値の統計を返す", () => {
    const stats = computeStats(rows, { row: 0, col: 0 }, { row: 0, col: 0 });
    expect(stats.count).toBe(1);
    expect(stats.sum).toBe(1);
    expect(stats.avg).toBe(1);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(1);
  });

  it("3x1 列選択: 合計・平均・最小・最大を計算する", () => {
    const stats = computeStats(rows, { row: 0, col: 0 }, { row: 2, col: 0 });
    expect(stats.count).toBe(3);
    expect(stats.sum).toBe(12); // 1+4+7
    expect(stats.avg).toBeCloseTo(4);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(7);
  });

  it("2x2 範囲選択: 正しい集計値を返す", () => {
    const stats = computeStats(rows, { row: 0, col: 0 }, { row: 1, col: 1 });
    expect(stats.count).toBe(4);
    expect(stats.sum).toBe(12); // 1+2+4+5
    expect(stats.avg).toBe(3);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(5);
  });

  it("文字列セルが混在する場合: 数値セルのみで集計する", () => {
    const mixedRows = [["hello", "2"], ["3", "world"]];
    const stats = computeStats(mixedRows, { row: 0, col: 0 }, { row: 1, col: 1 });
    expect(stats.count).toBe(4);
    expect(stats.sum).toBe(5); // 2+3
    expect(stats.avg).toBeCloseTo(2.5);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(3);
  });

  it("数値なしの場合: sum/avg/min/max が null", () => {
    const textRows = [["a", "b"], ["c", "d"]];
    const stats = computeStats(textRows, { row: 0, col: 0 }, { row: 1, col: 1 });
    expect(stats.count).toBe(4);
    expect(stats.sum).toBeNull();
    expect(stats.avg).toBeNull();
    expect(stats.min).toBeNull();
    expect(stats.max).toBeNull();
  });

  it("数十万セルの選択でも RangeError にならない", () => {
    const big = Array.from({ length: 300_000 }, (_, i) => [String(i)]);
    const stats = computeStats(big, { row: 0, col: 0 }, { row: 299_999, col: 0 });
    expect(stats.count).toBe(300_000);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(299_999);
  });
});
