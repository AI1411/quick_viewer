import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PdfViewer } from "../PdfViewer";
import { usePdfStore } from "../../../stores/pdfStore";

// Mock Tauri invoke and pdfLib
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("mock error")),
}));
vi.mock("../../../lib/pdfLib", () => ({
  loadPdfDocument: vi.fn().mockRejectedValue(new Error("mock error")),
}));

beforeEach(() => {
  usePdfStore.setState({ tabs: {} });
});

describe("PdfViewer", () => {
  it("shows loading state immediately after mount", () => {
    render(<PdfViewer tabId="t1" filePath="/test.pdf" />);
    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });
});
