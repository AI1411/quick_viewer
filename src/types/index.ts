export type FileFormat = "csv" | "tsv" | "pdf" | "markdown" | "xlsx" | "image";

export interface FileInfo {
  path: string;
  name: string;
  format: FileFormat;
  size: number;
}

// Rust の CsvMeta に対応
export interface CsvMeta {
  total_rows: number;
  columns: number;
  encoding: string;
  delimiter: string;
  headers: string[];
}

// Rust の CsvData に対応
export interface CsvData {
  headers: string[];
  rows: string[][];
  meta: CsvMeta;
  /** filter_csv / sort_csv の結果で、各行が元ファイルの何行目 (0 始まりのデータ行) か */
  source_rows?: number[];
}

// Rust の CsvChunk に対応
export interface CsvChunk {
  headers: string[];
  rows: string[][];
  offset: number;
  total_rows: number;
}

/** 表のスクロール位置 (px) */
export interface ScrollPosition {
  top: number;
  left: number;
}

export interface FilterCondition {
  /** 表示用の列名。同じ名前の列があり得るため、列の特定には column_index を使う */
  column: string;
  /** Prefer over `column` name when set (duplicate headers). */
  column_index?: number;
  filter_type:
    | "exact"
    | "contains"
    | "starts_with"
    | "regex"
    | "gt"
    | "lt"
    | "gte"
    | "lte"
    | "eq_num";
  value: string;
}

// ─── PDF Types ──────────────────────────────────────────────────────────────

// pdf.js 由来の PDF メタデータ / 目次（FE で構築）
export interface PdfInfo {
  page_count: number;
  title: string | null;
  author: string | null;
  subject: string | null;
  creator: string | null;
  producer: string | null;
  creation_date: string | null;
  modification_date: string | null;
  encrypted: boolean;
  outlines: OutlineItem[];
}

// pdf.js outline を正規化した再帰構造
export interface OutlineItem {
  title: string;
  page: number | null; // 0-based page index
  level: number;
  children: OutlineItem[];
}

export type PdfDisplayMode = "single" | "continuous";

// ─── Annotation Types ────────────────────────────────────────────────────────

/** アノテーション矩形（scale=1.0 時の PDF ユニット座標） */
export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotationColor = "yellow" | "green" | "blue" | "pink";

export interface HighlightAnnotation {
  id: string;
  type: "highlight";
  pageIndex: number; // 0-based
  color: AnnotationColor;
  rects: AnnotationRect[];
  selectedText: string;
  createdAt: string;
}

export interface NoteAnnotation {
  id: string;
  type: "note";
  pageIndex: number; // 0-based
  x: number; // scale=1.0 時の PDF ユニット座標
  y: number;
  content: string;
  createdAt: string;
}

export type Annotation = HighlightAnnotation | NoteAnnotation;

// ─── Markdown Types ───────────────────────────────────────────────────────────

export type ViewMode = "preview" | "source" | "split";

export interface TocItem {
  level: number;   // Heading level 1–6
  text: string;    // Heading text (plain)
  anchor: string;  // Slug ID used as element id
}

export interface MarkdownResult {
  html: string;
  toc: TocItem[];
  frontmatter: Record<string, unknown> | null;
  raw: string;
  /** Detected text encoding (e.g. "UTF-8", "Shift_JIS"). */
  encoding: string;
}

// ─── XLSX Types ───────────────────────────────────────────────────────────────

export interface XlsxSheetMeta {
  name: string;
  index: number;
}

export interface XlsxInfo {
  sheets: XlsxSheetMeta[];
  active_sheet_index: number;
}

export interface XlsxCell {
  value: string;
  raw: string;
  cell_type: "string" | "number" | "integer" | "boolean" | "date" | "empty" | "error";
  format_code: string | null;
}

export interface FreezePane {
  rows: number;
  cols: number;
}

export interface XlsxSheetData {
  name: string;
  rows: XlsxCell[][];
  total_rows: number;
  total_cols: number;
  /** rows の各行の列数。total_cols が上限を超えると切り詰められる。省略時は total_cols */
  loaded_cols?: number;
  freeze_pane: FreezePane;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export interface AppError {
  code: "io" | "parse" | "not_found" | "unsupported" | "unknown";
  message: string;
}

// ── 画像 (Rust の image_commands.rs に対応) ──────────────────

export interface ImageInfo {
  /** 撮影時の向きを反映した表示上の大きさ */
  width: number;
  height: number;
  format: string;
  frame_count: number;
  has_alpha: boolean;
  has_gps: boolean;
  file_size: number;
}

export type ImageFormatId = "jpeg" | "png" | "heic" | "avif" | "webp" | "tiff" | "gif" | "bmp";

export interface ImageFormatSpec {
  id: ImageFormatId;
  label: string;
  /** 先頭が既定の拡張子 */
  extensions: string[];
  mime: string;
  lossy: boolean;
  alpha: boolean;
  keeps_metadata: boolean;
}

export type ImageResize =
  | { kind: "none" }
  | { kind: "long_edge"; pixels: number }
  | { kind: "percent"; percent: number };

export type ImageMetadataPolicy = "keep" | "strip_location" | "strip_all";

export interface ImageConvertOptions {
  format: ImageFormatId;
  /** 1〜100。非可逆形式でだけ使われる */
  quality: number;
  /** 指定すると、このバイト数以下に収まる最高の品質を探す (足りなければ縮小) */
  target_bytes: number | null;
  resize: ImageResize;
  metadata: ImageMetadataPolicy;
}

export interface ImageEstimate {
  size: number;
  width: number;
  height: number;
  quality: number | null;
  preview: string | null;
}

export interface ImageConverted {
  output_path: string;
  size: number;
  width: number;
  height: number;
  quality: number | null;
}

export interface ImageBatchItem {
  source: string;
  source_size: number;
  output_path: string | null;
  size: number | null;
  error: string | null;
}

export interface ImageBatchProgress {
  done: number;
  total: number;
  item: ImageBatchItem;
}
