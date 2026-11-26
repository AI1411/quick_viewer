import { describe, it, expect } from "vitest";
import { parseSavedWindowState, toRestoreBounds } from "../lib/windowState";

const screen = [{ x: 0, y: 0, width: 1512, height: 982 }];

describe("toRestoreBounds", () => {
  it("旧形式 (物理ピクセル) は scaleFactor で割って論理ピクセルに戻す", () => {
    const saved = { width: 2400, height: 1600, x: 200, y: 100, isMaximized: false };
    expect(toRestoreBounds(saved, 2, screen)).toEqual({ width: 1200, height: 800, position: { x: 100, y: 50 } });
  });

  it("論理ピクセルで保存した値はそのまま戻す (起動のたびに倍にならない)", () => {
    const saved = { width: 1200, height: 800, x: 100, y: 50, isMaximized: false, unit: "logical" as const };
    const once = toRestoreBounds(saved, 2, screen);
    const twice = toRestoreBounds({ ...saved, ...once.position, width: once.width, height: once.height }, 2, screen);
    expect(twice).toEqual(once);
    expect(once.width).toBe(1200);
  });

  it("どのモニタにも見えない位置は復元しない", () => {
    const saved = { width: 1200, height: 800, x: 9000, y: 50, isMaximized: false, unit: "logical" as const };
    expect(toRestoreBounds(saved, 2, screen).position).toBeNull();
  });
});

describe("parseSavedWindowState", () => {
  it("数値でない値や壊れた形は null", () => {
    expect(parseSavedWindowState('{"width":"big"}')).toBeNull();
    expect(parseSavedWindowState("null")).toBeNull();
    expect(parseSavedWindowState('{"width":1,"height":2,"x":3,"y":4,"unit":"logical"}')).toEqual({
      width: 1, height: 2, x: 3, y: 4, isMaximized: false, unit: "logical",
    });
  });
});
