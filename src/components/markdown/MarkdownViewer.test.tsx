import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MarkdownViewer } from "./MarkdownViewer";
import { useMarkdownStore } from "../../stores/markdownStore";

vi.mock("./RenderedView", () => ({
  RenderedView: ({
    html,
    containerRef,
  }: {
    html: string;
    containerRef: React.RefObject<HTMLDivElement | null>;
    filePath: string;
    onScroll?: () => void;
  }) => (
    <div
      ref={containerRef}
      data-testid="rendered-view"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ),
}));

vi.mock("./TocSidebar", () => ({
  TocSidebar: ({ toc }: { toc: Array<{ text: string; anchor: string }> }) =>
    toc.length > 0 ? (
      <nav data-testid="toc-sidebar">{toc.map((t) => t.text).join(",")}</nav>
    ) : null,
}));

vi.mock("../../lib/markdownCommands", () => ({
  readMarkdown: vi.fn().mockResolvedValue({
    html: "",
    toc: [],
    frontmatter: null,
    raw: "",
  }),
  saveMarkdown: vi.fn(),
}));

describe("MarkdownViewer", () => {
  beforeEach(() => {
    useMarkdownStore.setState({ tabs: {} });
  });

  it("shows loading state when isLoading=true", () => {
    useMarkdownStore.setState({
      tabs: { t1: { data: null, isLoading: true, error: null, viewMode: "preview", editContent: null, isDirty: false } },
    });
    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    expect(screen.getByText(/読み込み中/)).toBeTruthy();
  });

  it("shows error state", async () => {
    const { readMarkdown } = await import("../../lib/markdownCommands");
    vi.mocked(readMarkdown).mockRejectedValueOnce("read failed");
    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    await waitFor(() => {
      expect(screen.getByText(/read failed/)).toBeTruthy();
    });
  });

  it("renders RenderedView and TocSidebar when data is available", async () => {
    const { readMarkdown } = await import("../../lib/markdownCommands");
    vi.mocked(readMarkdown).mockResolvedValueOnce({
      html: "<h1>Hello</h1>",
      toc: [{ level: 1, text: "Hello", anchor: "hello" }],
      frontmatter: null,
      raw: "# Hello",
    });
    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    await waitFor(() => {
      expect(screen.getByTestId("toc-sidebar").textContent).toBe("Hello");
    });
    expect(screen.getByTestId("rendered-view").innerHTML).toContain("Hello");
  });

  it("hides TocSidebar when toc is empty", async () => {
    const { readMarkdown } = await import("../../lib/markdownCommands");
    vi.mocked(readMarkdown).mockResolvedValueOnce({
      html: "<p>No headings</p>",
      toc: [],
      frontmatter: null,
      raw: "No headings",
    });
    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    await waitFor(() => {
      expect(screen.queryByTestId("rendered-view")).toBeTruthy();
    });
    expect(screen.queryByTestId("toc-sidebar")).toBeNull();
  });
});
