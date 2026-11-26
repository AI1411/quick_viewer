export interface SavedWindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  isMaximized: boolean;
  /** 無い場合は旧形式 (物理ピクセルで保存されていた) */
  unit?: "logical";
}

export interface LogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RestoreBounds {
  width: number;
  height: number;
  /** どのモニタにも見えない位置なら null (OS の既定位置のままにする) */
  position: { x: number; y: number } | null;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

export function parseSavedWindowState(raw: string): SavedWindowState | null {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  const nums = [s.width, s.height, s.x, s.y];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    width: s.width as number,
    height: s.height as number,
    x: s.x as number,
    y: s.y as number,
    isMaximized: s.isMaximized === true,
    unit: s.unit === "logical" ? "logical" : undefined,
  };
}

/**
 * 保存されたウィンドウ状態を論理ピクセルの復元値にする。
 * 旧形式は物理ピクセルなので scaleFactor で割る (Retina で起動のたびに倍になっていた)。
 */
export function toRestoreBounds(
  saved: SavedWindowState,
  scaleFactor: number,
  monitors: LogicalRect[]
): RestoreBounds {
  const k = saved.unit === "logical" ? 1 : scaleFactor || 1;
  const width = clamp(saved.width / k, 400, 7680);
  const height = clamp(saved.height / k, 300, 4320);
  const x = saved.x / k;
  const y = saved.y / k;
  // タイトルバー付近がいずれかのモニタ上に見えていれば、その位置に戻す
  const visible =
    monitors.length === 0 ||
    monitors.some(
      (m) => x + width > m.x + 100 && x < m.x + m.width - 100 && y >= m.y - 10 && y < m.y + m.height - 50
    );
  return { width, height, position: visible ? { x, y } : null };
}
