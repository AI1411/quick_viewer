import type { AppError } from "../types";

export function parseError(raw: unknown): AppError {
  if (typeof raw === "string") {
    if (raw.includes("No such file") || raw.includes("not found")) {
      return { code: "not_found", message: raw };
    }
    if (raw.includes("Unsupported")) {
      return { code: "unsupported", message: raw };
    }
    if (raw.includes("IO") || raw.includes("io")) {
      return { code: "io", message: raw };
    }
    return { code: "unknown", message: raw };
  }
  if (raw instanceof Error) {
    return { code: "unknown", message: raw.message };
  }
  return { code: "unknown", message: String(raw) };
}

export function errorMessage(raw: unknown): string {
  return parseError(raw).message;
}
