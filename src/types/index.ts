export type FileFormat = "csv" | "tsv" | "pdf" | "markdown" | "xlsx";

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
}

// Rust の CsvChunk に対応
export interface CsvChunk {
  headers: string[];
  rows: string[][];
  offset: number;
  total_rows: number;
}

export interface FilterCondition {
  column: string;
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

// Rust の PdfInfo に対応
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

// Rust の OutlineItem に対応（再帰構造）
export interface OutlineItem {
  title: string;
  page: number | null; // 0-based page index
  level: number;
  children: OutlineItem[];
}

// Rust の PdfPageData に対応
export interface PdfPageData {
  page_index: number;
  width: number;
  height: number;
  image_base64: string; // PNG as base64
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
  freeze_pane: FreezePane;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export interface AppError {
  code: "io" | "parse" | "not_found" | "unsupported" | "unknown";
  message: string;
}
