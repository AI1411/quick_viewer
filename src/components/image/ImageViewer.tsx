import type React from "react";
import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { ImageConvertOptions, ImageEstimate, ImageFormatSpec, ImageInfo } from "../../types";
import {
  convertImage,
  defaultOutputPath,
  estimateImage,
  fileName,
  formatBytes,
  formatChange,
  listImageFormats,
  readImageInfo,
  readImagePreview,
} from "../../lib/imageCommands";
import { showOpenImagesDialog } from "../../lib/fileCommands";
import { errorMessage } from "../../lib/errorUtils";
import { useImageStore } from "../../stores/imageStore";
import { showError, showInfo } from "../../stores/toastStore";
import { ConvertOptionsForm } from "./ConvertOptionsForm";

interface Props {
  tabId: string;
  filePath: string;
}

/** 表示用に読み込む画像の長辺の上限 */
const PREVIEW_MAX_EDGE = 4096;
const ESTIMATE_DEBOUNCE_MS = 400;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; info: ImageInfo; preview: string; formats: ImageFormatSpec[] };

type EstimateState =
  | { status: "running"; previous: ImageEstimate | null }
  | { status: "done"; estimate: ImageEstimate }
  | { status: "error"; message: string };

const checkerboard: React.CSSProperties = {
  backgroundColor: "var(--viewer-bg)",
  backgroundImage:
    "repeating-conic-gradient(rgba(128,128,128,0.18) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
};

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className="px-2 py-0.5 text-xs rounded cursor-pointer"
      style={{
        color: "var(--text-primary)",
        backgroundColor: active ? "var(--bg-hover)" : "transparent",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

export function ImageViewer({ tabId, filePath }: Props) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [estimate, setEstimate] = useState<EstimateState>({ status: "running", previous: null });
  const [showConverted, setShowConverted] = useState(false);
  const [fit, setFit] = useState(true);
  const [saving, setSaving] = useState(false);
  const estimateSeq = useRef(0);
  // 見積もりは同時に 1 件だけ走らせる。Rust 側の変換は途中で止められないので、
  // 設定を変えるたびに投げると古い変換が並行して走り続けてしまう
  const estimator = useRef<{ busy: boolean; queued: (() => void) | null; disposed: boolean }>({
    busy: false,
    queued: null,
    disposed: false,
  });
  useEffect(() => {
    const e = estimator.current;
    e.disposed = false;
    return () => {
      e.disposed = true;
      e.queued = null;
    };
  }, []);

  const storedOptions = useImageStore((s) => s.optionsByTab[tabId]);
  const [initialOptions] = useState(() => useImageStore.getState().lastOptions);
  const formats = load.status === "ready" ? load.formats : [];
  const requested = storedOptions ?? initialOptions;
  // 前回の形式がこの Mac で書き出せない場合は、書き出せる最初の形式にする
  const options: ImageConvertOptions =
    formats.length === 0 || formats.some((f) => f.id === requested.format)
      ? requested
      : { ...requested, format: formats[0].id };
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    Promise.all([
      readImageInfo(filePath),
      readImagePreview(filePath, PREVIEW_MAX_EDGE),
      listImageFormats(),
    ])
      .then(([info, preview, formats]) => {
        if (!cancelled) setLoad({ status: "ready", info, preview, formats });
      })
      .catch((err) => {
        if (!cancelled) setLoad({ status: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // 設定を変えるたびに、保存せずに変換だけ行って結果のサイズを表示する
  const ready = load.status === "ready";
  useEffect(() => {
    if (!ready) return;
    const seq = ++estimateSeq.current;
    setEstimate((prev) => ({
      status: "running",
      previous: prev.status === "done" ? prev.estimate : prev.status === "running" ? prev.previous : null,
    }));
    const run = () => {
      const e = estimator.current;
      // 待っている間にさらに設定が変わっていたら、この要求は捨てる (新しい要求が後から来る)
      if (e.disposed || seq !== estimateSeq.current) return;
      if (e.busy) {
        e.queued = run;
        return;
      }
      e.busy = true;
      estimateImage(filePath, JSON.parse(optionsKey) as ImageConvertOptions, showConverted)
        .then((result) => {
          if (seq === estimateSeq.current) setEstimate({ status: "done", estimate: result });
        })
        .catch((err) => {
          if (seq === estimateSeq.current) setEstimate({ status: "error", message: errorMessage(err) });
        })
        .finally(() => {
          e.busy = false;
          const next = e.queued;
          e.queued = null;
          next?.();
        });
    };
    const timer = setTimeout(run, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ready, filePath, optionsKey, showConverted]);

  if (load.status === "loading") {
    return (
      <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "var(--text-secondary)" }}>
        読み込み中...
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="flex-1 flex items-center justify-center text-sm px-6 text-center" style={{ color: "#ef4444" }}>
        エラー: {load.message}
      </div>
    );
  }

  const { info, preview } = load;
  const spec = formats.find((f) => f.id === options.format);
  const latest =
    estimate.status === "done" ? estimate.estimate : estimate.status === "running" ? estimate.previous : null;
  const convertedPreview = showConverted ? (latest?.preview ?? null) : null;
  const shownWidth = showConverted && latest ? latest.width : info.width;

  const handleSave = async () => {
    if (!spec) return;
    try {
      const outputPath = await save({
        defaultPath: defaultOutputPath(filePath, spec),
        filters: [{ name: spec.label, extensions: spec.extensions }],
      });
      if (!outputPath) return;
      setSaving(true);
      const result = await convertImage(filePath, outputPath, options);
      showInfo(
        `保存しました: ${fileName(result.output_path)}（${formatBytes(result.size)}、${formatChange(info.file_size, result.size)}）`
      );
    } catch (err) {
      showError(`保存に失敗しました: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleBatch = async () => {
    try {
      const paths = await showOpenImagesDialog();
      if (paths.length > 0) useImageStore.getState().openBatch(paths);
    } catch (err) {
      showError(`ファイルを選択できませんでした: ${errorMessage(err)}`);
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden" style={{ color: "var(--text-primary)" }}>
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div
          className="flex items-center gap-1 px-3 py-1 shrink-0 border-b"
          style={{ borderColor: "var(--border-color)", backgroundColor: "var(--toolbar-bg)" }}
        >
          <ToggleButton active={fit} onClick={() => setFit(true)}>
            フィット
          </ToggleButton>
          <ToggleButton active={!fit} onClick={() => setFit(false)}>
            原寸
          </ToggleButton>
          <span className="mx-2 h-4 border-l" style={{ borderColor: "var(--border-color)" }} />
          <ToggleButton active={!showConverted} onClick={() => setShowConverted(false)}>
            元の画像
          </ToggleButton>
          <ToggleButton active={showConverted} onClick={() => setShowConverted(true)}>
            変換後
          </ToggleButton>
          <span className="ml-auto text-xs" style={{ color: "var(--text-secondary)" }}>
            {info.format} · {info.width}×{info.height} · {formatBytes(info.file_size)}
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto flex relative" style={checkerboard}>
          {showConverted && !convertedPreview ? (
            <p className="m-auto text-sm" style={{ color: "var(--text-secondary)" }}>
              {estimate.status === "error"
                ? "変換できませんでした"
                : estimate.status === "running"
                  ? "変換中..."
                  : "変換後の画像が大きいためプレビューできません"}
            </p>
          ) : (
            <img
              src={convertedPreview ?? preview}
              alt={fileName(filePath)}
              className="m-auto"
              style={
                fit
                  ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
                  : { width: shownWidth, maxWidth: "none" }
              }
            />
          )}
        </div>
      </div>

      <aside
        className="w-72 shrink-0 flex flex-col gap-3 p-3 overflow-y-auto border-l"
        style={{ borderColor: "var(--border-color)", backgroundColor: "var(--bg-secondary)" }}
        aria-label="変換・圧縮"
      >
        <h2 className="text-sm font-semibold">変換・圧縮</h2>
        {info.frame_count > 1 && (
          <p className="text-xs" style={{ color: "#f59e0b" }}>
            この画像は {info.frame_count} フレームあります。変換されるのは 1 枚目だけです。
          </p>
        )}
        <ConvertOptionsForm
          formats={formats}
          value={options}
          onChange={(next) => useImageStore.getState().setOptions(tabId, next)}
          sourceHasGps={info.has_gps}
          sourceHasAlpha={info.has_alpha}
        />

        <div
          className="rounded p-2 text-sm"
          style={{ backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)" }}
          role="status"
        >
          {estimate.status === "error" ? (
            <span style={{ color: "#ef4444" }}>{estimate.message}</span>
          ) : latest ? (
            <>
              <div className="font-medium" style={{ opacity: estimate.status === "running" ? 0.5 : 1 }}>
                変換後: {formatBytes(latest.size)}（{formatChange(info.file_size, latest.size)}）
              </div>
              <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {latest.width}×{latest.height}
                {latest.quality !== null && ` · 品質 ${latest.quality}`}
              </div>
              {estimate.status === "done" && options.target_bytes !== null && latest.size > options.target_bytes && (
                <div className="text-xs" style={{ color: "#f59e0b" }}>
                  目標サイズには収まりませんでした。
                </div>
              )}
            </>
          ) : (
            <span style={{ color: "var(--text-secondary)" }}>計算中...</span>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !spec}
          className="px-3 py-1.5 rounded text-sm font-medium cursor-pointer disabled:opacity-50"
          style={{ backgroundColor: "#3b82f6", color: "#ffffff" }}
        >
          {saving ? "保存中..." : "保存..."}
        </button>
        <button
          onClick={handleBatch}
          className="px-3 py-1.5 rounded text-sm cursor-pointer"
          style={{ backgroundColor: "var(--bg-hover)", color: "var(--text-primary)" }}
        >
          複数の画像を一括変換...
        </button>
      </aside>
    </div>
  );
}
