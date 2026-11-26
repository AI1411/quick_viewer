import { describe, it, expect } from "vitest";
import { rectToPageSpace, rectToScreenSpace, toPageSpace, toScreenSpace } from "../lib/annotationGeometry";

// 幅 600 x 高さ 800 の縦長ページ
const size = { width: 600, height: 800 };
// 左上付近の見出しの位置 (回転 0°)
const heading = { x: 50, y: 40, width: 200, height: 20 };

describe("annotationGeometry", () => {
  it("どの回転でも画面座標とページ座標を往復すると元に戻る", () => {
    for (const rotation of [0, 90, 180, 270, -90, 450]) {
      const p = { x: 123, y: 456 };
      expect(toPageSpace(toScreenSpace(p, rotation, size), rotation, size)).toEqual(p);
    }
  });

  it("90° 回転した表示では、ページ左上の見出しは右上に来る (pdf.js の時計回り回転と一致)", () => {
    const shown = rectToScreenSpace(heading, 90, size);
    // 回転後の表示は幅 800 x 高さ 600
    expect(shown).toEqual({ x: 800 - 40 - 20, y: 50, width: 20, height: 200 });
  });

  it("回転中に作った注釈は、回転を戻しても同じ位置に表示される", () => {
    const madeWhileRotated = rectToPageSpace(rectToScreenSpace(heading, 270, size), 270, size);
    expect(rectToScreenSpace(madeWhileRotated, 0, size)).toEqual(heading);
  });
});
