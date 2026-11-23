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
    encoding: "UTF-8",
  }),
  saveMarkdown: vi.fn(),
  renderMarkdownString: vi.fn().mockResolvedValue({
    html: "",
    toc: [],
    frontmatter: null,
    raw: "",
    encoding: "UTF-8",
  }),
}));

vi.mock("../../stores/toastStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../stores/toastStore")>();
  return { ...actual, showError: vi.fn() };
});

describe("MarkdownViewer", () => {
  beforeEach(() => {
    useMarkdownStore.setState({ tabs: {} });
    vi.clearAllMocks();
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
      encoding: "UTF-8",
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
      encoding: "UTF-8",
    });
    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    await waitFor(() => {
      expect(screen.queryByTestId("rendered-view")).toBeTruthy();
    });
    expect(screen.queryByTestId("toc-sidebar")).toBeNull();
  });

  it("Cmd+S saves without toggling isLoading and keeps the editor mounted", async () => {
    const { readMarkdown, saveMarkdown, renderMarkdownString } = await import(
      "../../lib/markdownCommands"
    );
    vi.mocked(readMarkdown).mockResolvedValue({
      html: "<p>old</p>",
      toc: [],
      frontmatter: null,
      raw: "old",
      encoding: "Shift_JIS",
    });
    vi.mocked(saveMarkdown).mockResolvedValue(undefined);
    vi.mocked(renderMarkdownString).mockResolvedValue({
      html: "<p>new</p>",
      toc: [],
      frontmatter: null,
      raw: "new",
      encoding: "UTF-8",
    });

    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    await waitFor(() => {
      expect(useMarkdownStore.getState().tabs.t1?.data?.raw).toBe("old");
    });

    useMarkdownStore.getState().setViewMode("t1", "source");
    useMarkdownStore.getState().setEditContent("t1", "new");
    useMarkdownStore.getState().setDirty("t1", true);

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeTruthy();
    });
    const textarea = screen.getByRole("textbox");

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true })
    );

    await waitFor(() => {
      expect(saveMarkdown).toHaveBeenCalledWith("/test.md", "new", "Shift_JIS");
    });
    expect(readMarkdown).toHaveBeenCalledTimes(1);
    expect(renderMarkdownString).toHaveBeenCalledWith("new");
    expect(useMarkdownStore.getState().tabs.t1?.isLoading).toBe(false);
    expect(screen.getByRole("textbox")).toBe(textarea);

    await waitFor(() => {
      expect(useMarkdownStore.getState().tabs.t1?.isDirty).toBe(false);
      expect(useMarkdownStore.getState().tabs.t1?.data?.html).toBe("<p>new</p>");
      expect(useMarkdownStore.getState().tabs.t1?.data?.encoding).toBe("Shift_JIS");
    });
  });

  it("Cmd+S failure shows a toast and keeps the editor visible", async () => {
    const { readMarkdown, saveMarkdown } = await import("../../lib/markdownCommands");
    const { showError } = await import("../../stores/toastStore");
    vi.mocked(readMarkdown).mockResolvedValue({
      html: "<p>old</p>",
      toc: [],
      frontmatter: null,
      raw: "old",
      encoding: "UTF-8",
    });
    vi.mocked(saveMarkdown).mockRejectedValue("disk full");

    render(<MarkdownViewer tabId="t1" filePath="/test.md" />);
    await waitFor(() => {
      expect(useMarkdownStore.getState().tabs.t1?.data?.raw).toBe("old");
    });

    useMarkdownStore.getState().setViewMode("t1", "source");
    useMarkdownStore.getState().setEditContent("t1", "new");
    useMarkdownStore.getState().setDirty("t1", true);

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeTruthy();
    });

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true })
    );

    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("保存に失敗しました: disk full");
    });
    expect(useMarkdownStore.getState().tabs.t1?.error).toBeNull();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.queryByText(/エラー:/)).toBeNull();
  });
});
