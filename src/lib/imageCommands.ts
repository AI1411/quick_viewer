import { invoke } from "@tauri-apps/api/core";
import type {
  ImageBatchItem,
  ImageConvertOptions,
  ImageConverted,
  ImageEstimate,
  ImageFormatSpec,
  ImageInfo,
} from "../types";

/** 画像として開く拡張子。Rust の IMAGE_EXTENSIONS (lib.rs) と同じ内容にする (テストで照合している) */
export const IMAGE_EXTENSIONS = [
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "jxl",
  "jp2", "psd", "ico", "tga", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef",
  "srw",
] as const;

export const DEFAULT_IMAGE_OPTIONS: ImageConvertOptions = {
  format: "jpeg",
  quality: 80,
  target_bytes: null,
  resize: { kind: "none" },
  metadata: "keep",
};

let formatsPromise: Promise<ImageFormatSpec[]> | null = null;

/** この Mac で書き出せる形式。OS のバージョンで変わるため実行時に問い合わせる */
export function listImageFormats(): Promise<ImageFormatSpec[]> {
  formatsPromise ??= invoke<ImageFormatSpec[]>("list_image_formats").catch((err) => {
    formatsPromise = null;
    throw err;
  });
  return formatsPromise;
}

export function readImageInfo(path: string): Promise<ImageInfo> {
  return invoke<ImageInfo>("read_image_info", { path });
}

export function readImagePreview(path: string, maxEdge: number): Promise<string> {
  return invoke<string>("read_image_preview", { path, maxEdge });
}

export function estimateImage(
  path: string,
  options: ImageConvertOptions,
  withPreview: boolean
): Promise<ImageEstimate> {
  return invoke<ImageEstimate>("estimate_image", { path, options, withPreview });
}

export function convertImage(
  path: string,
  outputPath: string,
  options: ImageConvertOptions
): Promise<ImageConverted> {
  return invoke<ImageConverted>("convert_image", { path, outputPath, options });
}

export function convertImages(
  paths: string[],
  outputDir: string,
  options: ImageConvertOptions
): Promise<ImageBatchItem[]> {
  return invoke<ImageBatchItem[]>("convert_images", { paths, outputDir, options });
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? path.slice(0, i + 1) : path.slice(0, i);
}

/**
 * 保存ダイアログの初期値。元と同じフォルダ・同じ名前で拡張子だけ変える。
 * 元のファイルと同じパスになる場合 (同じ形式での再圧縮) は上書きにならないよう名前を変える。
 */
export function defaultOutputPath(sourcePath: string, spec: ImageFormatSpec): string {
  const name = fileName(sourcePath);
  const dir = sourcePath.slice(0, sourcePath.length - name.length);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const sourceExt = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const sameFormat = spec.extensions.includes(sourceExt);
  return `${dir}${stem}${sameFormat ? "-converted" : ""}.${spec.extensions[0]}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

/** 元のサイズに対する増減。例: "-73%" "+12%" */
export function formatChange(before: number, after: number): string {
  if (before <= 0) return "";
  const percent = Math.round(((after - before) / before) * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}
