export type FileFormat = "csv" | "tsv" | "pdf" | "markdown" | "xlsx";

export interface FileInfo {
  path: string;
  name: string;
  format: FileFormat;
  size: number;
}
