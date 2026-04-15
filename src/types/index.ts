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
