import type React from "react";
import { useId } from "react";
import type {
  ImageConvertOptions,
  ImageFormatSpec,
  ImageMetadataPolicy,
  ImageResize,
} from "../../types";

interface Props {
  formats: ImageFormatSpec[];
  value: ImageConvertOptions;
  onChange: (value: ImageConvertOptions) => void;
  /** 元画像に位置情報がある (あるときだけ注意書きを出す) */
  sourceHasGps?: boolean;
  /** 元画像に透過がある (透過を持てない形式を選んだときに注意書きを出す) */
  sourceHasAlpha?: boolean;
}

const DEFAULT_TARGET_BYTES = 500 * 1024;

const RESIZE_DEFAULTS: Record<ImageResize["kind"], ImageResize> = {
  none: { kind: "none" },
  long_edge: { kind: "long_edge", pixels: 1920 },
  percent: { kind: "percent", percent: 50 },
};

const METADATA_LABELS: Record<ImageMetadataPolicy, string> = {
  keep: "保持する",
  strip_location: "位置情報だけ削除",
  strip_all: "すべて削除",
};

const fieldStyle: React.CSSProperties = {
  backgroundColor: "var(--bg-primary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
};

function clampInt(raw: string, min: number, max: number): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
      {children}
    </p>
  );
}

export function ConvertOptionsForm({ formats, value, onChange, sourceHasGps, sourceHasAlpha }: Props) {
  const spec = formats.find((f) => f.id === value.format);
  const byTarget = value.target_bytes !== null;
  // 同じ name のラジオボタンは画面全体で 1 グループになるため、フォームごとに別の名前にする
  const modeGroup = useId();
  const set = (patch: Partial<ImageConvertOptions>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-3 text-sm">
      <Row label="形式">
        <select
          aria-label="形式"
          className="rounded px-2 py-1"
          style={fieldStyle}
          value={value.format}
          onChange={(e) => set({ format: e.target.value as ImageConvertOptions["format"] })}
        >
          {formats.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        {sourceHasAlpha && spec && !spec.alpha && <Note>透過部分は白背景になります。</Note>}
      </Row>

      <Row label="圧縮">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={modeGroup}
            checked={!byTarget}
            onChange={() => set({ target_bytes: null })}
          />
          品質で指定
        </label>
        {!byTarget &&
          (spec?.lossy ? (
            <div className="flex items-center gap-2 pl-5">
              <input
                type="range"
                aria-label="品質"
                min={1}
                max={100}
                value={value.quality}
                onChange={(e) => set({ quality: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="w-8 text-right tabular-nums">{value.quality}</span>
            </div>
          ) : (
            <Note>この形式は画質を落とさずに保存します。</Note>
          ))}
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={modeGroup}
            checked={byTarget}
            onChange={() => set({ target_bytes: value.target_bytes ?? DEFAULT_TARGET_BYTES })}
          />
          目標サイズで指定
        </label>
        {byTarget && (
          <div className="flex flex-col gap-1 pl-5">
            <div className="flex items-center gap-2">
              <input
                type="number"
                aria-label="目標サイズ (KB)"
                min={1}
                className="w-24 rounded px-2 py-1"
                style={fieldStyle}
                value={Math.round((value.target_bytes ?? 0) / 1024)}
                onChange={(e) => {
                  const kb = clampInt(e.target.value, 1, 1024 * 1024);
                  if (kb !== null) set({ target_bytes: kb * 1024 });
                }}
              />
              KB 以下
            </div>
            <Note>
              {spec?.lossy
                ? "収まる範囲で最も高い品質を選び、足りなければ縮小します。"
                : "収まるまで縮小します。"}
            </Note>
          </div>
        )}
      </Row>

      <Row label="リサイズ">
        <select
          aria-label="リサイズ"
          className="rounded px-2 py-1"
          style={fieldStyle}
          value={value.resize.kind}
          onChange={(e) => set({ resize: RESIZE_DEFAULTS[e.target.value as ImageResize["kind"]] })}
        >
          <option value="none">しない</option>
          <option value="long_edge">長辺を指定</option>
          <option value="percent">割合で指定</option>
        </select>
        {value.resize.kind === "long_edge" && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              aria-label="長辺 (px)"
              min={1}
              className="w-24 rounded px-2 py-1"
              style={fieldStyle}
              value={value.resize.pixels}
              onChange={(e) => {
                const pixels = clampInt(e.target.value, 1, 65_535);
                if (pixels !== null) set({ resize: { kind: "long_edge", pixels } });
              }}
            />
            px 以下
          </div>
        )}
        {value.resize.kind === "percent" && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              aria-label="割合 (%)"
              min={1}
              max={100}
              className="w-24 rounded px-2 py-1"
              style={fieldStyle}
              value={value.resize.percent}
              onChange={(e) => {
                const percent = clampInt(e.target.value, 1, 100);
                if (percent !== null) set({ resize: { kind: "percent", percent } });
              }}
            />
            %
          </div>
        )}
      </Row>

      <Row label="メタデータ (撮影日時・カメラ・位置情報)">
        {spec && !spec.keeps_metadata ? (
          <Note>{spec.label} ではメタデータは保存されません。</Note>
        ) : (
          <>
            <select
              aria-label="メタデータ"
              className="rounded px-2 py-1"
              style={fieldStyle}
              value={value.metadata}
              onChange={(e) => set({ metadata: e.target.value as ImageMetadataPolicy })}
            >
              {(Object.keys(METADATA_LABELS) as ImageMetadataPolicy[]).map((policy) => (
                <option key={policy} value={policy}>
                  {METADATA_LABELS[policy]}
                </option>
              ))}
            </select>
            {sourceHasGps && value.metadata === "keep" && (
              <p className="text-xs" style={{ color: "#f59e0b" }}>
                この画像には位置情報が含まれています。共有する場合は削除を検討してください。
              </p>
            )}
          </>
        )}
      </Row>
    </div>
  );
}
