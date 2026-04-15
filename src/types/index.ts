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
