import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("shows error state", () => {
    useMarkdownStore.setState({
      tabs: { t1: { data: null, isLoading: false, error: "read failed", viewMode: "preview", editContent: null, isDirty: false } },
    });
    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    expect(screen.getByText(/read failed/)).toBeTruthy();
  });

  it("renders RenderedView and TocSidebar when data is available", () => {
    useMarkdownStore.setState({
      tabs: {
        t1: {
          data: {
            html: "<h1>Hello</h1>",
            toc: [{ level: 1, text: "Hello", anchor: "hello" }],
            frontmatter: null,
            raw: "# Hello",
          },
          isLoading: false,
          error: null,
          viewMode: "preview",
          editContent: null,
          isDirty: false,
        },
      },
    });
    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    expect(screen.getByTestId("toc-sidebar").textContent).toBe("Hello");
    expect(screen.getByTestId("rendered-view").innerHTML).toContain("Hello");
  });

  it("hides TocSidebar when toc is empty", () => {
    useMarkdownStore.setState({
      tabs: {
        t1: {
          data: {
            html: "<p>No headings</p>",
            toc: [],
            frontmatter: null,
            raw: "No headings",
          },
          isLoading: false,
          error: null,
          viewMode: "preview",
          editContent: null,
          isDirty: false,
        },
      },
    });
    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    expect(screen.queryByTestId("toc-sidebar")).toBeNull();
  });
});
