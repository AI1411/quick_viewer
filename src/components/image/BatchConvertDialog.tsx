import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ImageBatchItem, ImageBatchProgress, ImageFormatSpec } from "../../types";
import {
  convertImages,
  fileName,
  formatBytes,
  formatChange,
  listImageFormats,
  parentDir,
} from "../../lib/imageCommands";
import { showOpenFolderDialog, showOpenImagesDialog } from "../../lib/fileCommands";
import { errorMessage } from "../../lib/errorUtils";
import { useImageStore } from "../../stores/imageStore";
import { showError } from "../../stores/toastStore";
import { ConvertOptionsForm } from "./ConvertOptionsForm";

type RunState =
  | { status: "idle" }
  | { status: "running"; done: number; total: number }
  | { status: "finished"; results: ImageBatchItem[] }
  | { status: "failed"; message: string };

function Summary({ results }: { results: ImageBatchItem[] }) {
  const succeeded = results.filter((r) => r.output_path !== null);
  const failed = results.filter((r) => r.error !== null);
  const before = succeeded.reduce((sum, r) => sum + r.source_size, 0);
  const after = succeeded.reduce((sum, r) => sum + (r.size ?? 0), 0);
  const firstOutput = succeeded[0]?.output_path;

  return (
    <div className="flex flex-col gap-2 text-sm" role="status">
      <p className="font-medium">
        {succeeded.length} 件を変換しました
        {failed.length > 0 && `（${failed.length} 件は失敗）`}
      </p>
      {succeeded.length > 0 && (
        <p style={{ color: "var(--text-secondary)" }}>
          合計 {formatBytes(before)} → {formatBytes(after)}（{formatChange(before, after)}）
        </p>
      )}
      {failed.length > 0 && (
        <ul className="text-xs max-h-32 overflow-y-auto" style={{ color: "#ef4444" }}>
          {failed.map((r) => (
            <li key={r.source}>
              {fileName(r.source)}: {r.error}
            </li>
          ))}
        </ul>
      )}
      {firstOutput && (
        <button
          className="self-start px-3 py-1 rounded text-xs cursor-pointer"
          style={{ backgroundColor: "var(--bg-hover)", color: "var(--text-primary)" }}
          onClick={() => {
            revealItemInDir(firstOutput).catch((err: unknown) =>
              showError(`保存先を開けませんでした: ${errorMessage(err)}`)
            );
          }}
        >
          保存先を Finder で表示
        </button>
      )}
    </div>
  );
}

export function BatchConvertDialog() {
  const initialPaths = useImageStore((s) => s.batchPaths);
  const close = useImageStore((s) => s.closeBatch);
  const [paths, setPaths] = useState<string[]>(initialPaths ?? []);
  const [outputDir, setOutputDir] = useState(() => parentDir(initialPaths?.[0] ?? ""));
  const [options, setOptions] = useState(() => useImageStore.getState().lastOptions);
  const [formats, setFormats] = useState<ImageFormatSpec[]>([]);
  const [run, setRun] = useState<RunState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    listImageFormats()
      .then((list) => {
        if (cancelled) return;
        setFormats(list);
        // 前回の形式がこの Mac で書き出せない場合は、書き出せる最初の形式にする
        setOptions((o) => (list.length === 0 || list.some((f) => f.id === o.format) ? o : { ...o, format: list[0].id }));
      })
      .catch((err) => {
        if (!cancelled) setRun({ status: "failed", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const running = run.status === "running";

  const addFiles = async () => {
    try {
      const added = await showOpenImagesDialog();
      setPaths((current) => [...current, ...added.filter((p) => !current.includes(p))]);
    } catch (err) {
      showError(`ファイルを選択できませんでした: ${errorMessage(err)}`);
    }
  };

  const chooseFolder = async () => {
    try {
      const dir = await showOpenFolderDialog(outputDir || undefined);
      if (dir) setOutputDir(dir);
    } catch (err) {
      showError(`フォルダを選択できませんでした: ${errorMessage(err)}`);
    }
  };

  const start = async () => {
    setRun({ status: "running", done: 0, total: paths.length });
    useImageStore.getState().setLastOptions(options);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<ImageBatchProgress>("image-convert-progress", (event) => {
        setRun((r) => (r.status === "running" ? { ...r, done: event.payload.done } : r));
      });
      const results = await convertImages(paths, outputDir, options);
      setRun({ status: "finished", results });
    } catch (err) {
      setRun({ status: "failed", message: errorMessage(err) });
    } finally {
      unlisten?.();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="画像の一括変換"
        className="rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{
          width: "480px",
          maxHeight: "85vh",
          backgroundColor: "var(--bg-secondary)",
          color: "var(--text-primary)",
          border: "1px solid var(--border)",
        }}
      >
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <h2 className="text-base font-semibold">画像の一括変換</h2>
          <button
            onClick={close}
            disabled={running}
            aria-label="閉じる"
            className="rounded-full w-6 h-6 flex items-center justify-center text-sm cursor-pointer disabled:opacity-40"
            style={{ backgroundColor: "var(--bg-hover)", color: "var(--text-secondary)" }}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4 overflow-y-auto">
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{paths.length} 個の画像</span>
              <button
                onClick={addFiles}
                disabled={running}
                className="px-2 py-0.5 rounded text-xs cursor-pointer disabled:opacity-40"
                style={{ backgroundColor: "var(--bg-hover)" }}
              >
                画像を追加...
              </button>
            </div>
            <p className="text-xs truncate" style={{ color: "var(--text-secondary)" }}>
              {paths.slice(0, 3).map(fileName).join("、")}
              {paths.length > 3 && ` ほか ${paths.length - 3} 個`}
            </p>
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">保存先</span>
              <button
                onClick={chooseFolder}
                disabled={running}
                className="px-2 py-0.5 rounded text-xs cursor-pointer disabled:opacity-40"
                style={{ backgroundColor: "var(--bg-hover)" }}
              >
                変更...
              </button>
            </div>
            <p className="text-xs break-all" style={{ color: "var(--text-secondary)" }}>
              {outputDir || "未選択"}
            </p>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              同じ名前のファイルがある場合は上書きせず、名前に番号を付けて保存します。
            </p>
          </div>

          <ConvertOptionsForm formats={formats} value={options} onChange={setOptions} />

          {run.status === "running" && (
            <div className="flex flex-col gap-1 text-sm" role="status">
              <span>
                変換中... {run.done} / {run.total}
              </span>
              <progress value={run.done} max={run.total} className="w-full" />
            </div>
          )}
          {run.status === "finished" && <Summary results={run.results} />}
          {run.status === "failed" && (
            <p className="text-sm" style={{ color: "#ef4444" }} role="alert">
              変換できませんでした: {run.message}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3" style={{ borderTop: "1px solid var(--border)" }}>
          <button
            onClick={close}
            disabled={running}
            className="px-3 py-1.5 rounded text-sm cursor-pointer disabled:opacity-40"
            style={{ backgroundColor: "var(--bg-hover)" }}
          >
            閉じる
          </button>
          <button
            onClick={start}
            disabled={running || paths.length === 0 || !outputDir || formats.length === 0}
            className="px-3 py-1.5 rounded text-sm font-medium cursor-pointer disabled:opacity-50"
            style={{ backgroundColor: "#3b82f6", color: "#ffffff" }}
          >
            {run.status === "finished" ? "もう一度変換" : "変換を開始"}
          </button>
        </div>
      </div>
    </div>
  );
}
