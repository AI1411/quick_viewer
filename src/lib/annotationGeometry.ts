import type { AnnotationRect } from "../types";

/** 回転 0°・倍率 1.0 のときのページサイズ */
export interface PageSize {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

const normalize = (rotation: number) => ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;

/**
 * 画面上の点 (倍率 1.0、時計回りに rotation 度回転した表示) をページ座標 (回転 0°) に変換する。
 * 注釈はページ座標で保存し、回転を変えても同じ文字の上に表示されるようにする。
 */
export function toPageSpace(p: Point, rotation: number, size: PageSize): Point {
  switch (normalize(rotation)) {
    case 90:
      return { x: p.y, y: size.height - p.x };
    case 180:
      return { x: size.width - p.x, y: size.height - p.y };
    case 270:
      return { x: size.width - p.y, y: p.x };
    default:
      return p;
  }
}

/** ページ座標 (回転 0°) を、時計回りに rotation 度回転した表示上の点に変換する */
export function toScreenSpace(p: Point, rotation: number, size: PageSize): Point {
  switch (normalize(rotation)) {
    case 90:
      return { x: size.height - p.y, y: p.x };
    case 180:
      return { x: size.width - p.x, y: size.height - p.y };
    case 270:
      return { x: p.y, y: size.width - p.x };
    default:
      return p;
  }
}

function transformRect(rect: AnnotationRect, f: (p: Point) => Point): AnnotationRect {
  const a = f({ x: rect.x, y: rect.y });
  const b = f({ x: rect.x + rect.width, y: rect.y + rect.height });
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export const rectToPageSpace = (rect: AnnotationRect, rotation: number, size: PageSize) =>
  transformRect(rect, (p) => toPageSpace(p, rotation, size));

export const rectToScreenSpace = (rect: AnnotationRect, rotation: number, size: PageSize) =>
  transformRect(rect, (p) => toScreenSpace(p, rotation, size));
