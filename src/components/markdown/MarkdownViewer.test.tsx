import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

describe("MarkdownViewer の再マウント (タブ切替・再読み込み)", () => {
  const md = (raw: string) => ({ html: "", toc: [], frontmatter: null, raw, encoding: "UTF-8" });

  beforeEach(() => {
    useMarkdownStore.setState({ tabs: {} });
    vi.clearAllMocks();
  });

  it("未編集ならエディタは外部で変更された最新の内容を表示し、保存で巻き戻さない", async () => {
    const cmds = await import("../../lib/markdownCommands");
    vi.mocked(cmds.readMarkdown).mockResolvedValue(md("v1 original"));
    vi.mocked(cmds.saveMarkdown).mockResolvedValue(undefined);
    const first = render(<MarkdownViewer tabId="t1" filePath="/note.md" />);
    fireEvent.click(await screen.findByText("ソース"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("v1 original");
    first.unmount();

    vi.mocked(cmds.readMarkdown).mockResolvedValue(md("v2 changed elsewhere"));
    render(<MarkdownViewer tabId="t1" filePath="/note.md" />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("v2 changed elsewhere"));

    fireEvent.change(box, { target: { value: box.value + "!" } });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
    });
    expect(vi.mocked(cmds.saveMarkdown)).toHaveBeenCalledWith("/note.md", "v2 changed elsewhere!", "UTF-8");
  });

  it("未保存の編集はタブを切り替えて戻っても残る", async () => {
    const cmds = await import("../../lib/markdownCommands");
    vi.mocked(cmds.readMarkdown).mockResolvedValue(md("base"));
    const first = render(<MarkdownViewer tabId="t1" filePath="/note.md" />);
    fireEvent.click(await screen.findByText("ソース"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "base + my edit" } });
    first.unmount();

    render(<MarkdownViewer tabId="t1" filePath="/note.md" />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(box.value).toBe("base + my edit");
    expect(useMarkdownStore.getState().tabs.t1.isDirty).toBe(true);
  });

  it("一度読込エラーになっても、再マウントで読めれば表示に戻る", async () => {
    const cmds = await import("../../lib/markdownCommands");
    vi.mocked(cmds.readMarkdown).mockRejectedValueOnce("temporary failure");
    const first = render(<MarkdownViewer tabId="t1" filePath="/note.md" />);
    await screen.findByText(/temporary failure/);
    first.unmount();

    vi.mocked(cmds.readMarkdown).mockResolvedValue(md("ok now"));
    render(<MarkdownViewer tabId="t1" filePath="/note.md" />);
    await screen.findByTestId("rendered-view");
    expect(screen.queryByText(/temporary failure/)).toBeNull();
  });
});


describe("MarkdownViewer の保存中の入力", () => {
  const md = (raw: string) => ({ html: "", toc: [], frontmatter: null, raw, encoding: "UTF-8" });

  beforeEach(() => {
    useMarkdownStore.setState({ tabs: {} });
    vi.clearAllMocks();
  });

  it("保存中に続けて入力した分は未保存のまま残る", async () => {
    const cmds = await import("../../lib/markdownCommands");
    vi.mocked(cmds.readMarkdown).mockResolvedValue(md("base"));
    vi.mocked(cmds.renderMarkdownString).mockImplementation(async (content) => md(content));
    let finishSave: () => void = () => {};
    vi.mocked(cmds.saveMarkdown).mockImplementation(
      () => new Promise<void>((resolve) => { finishSave = resolve; })
    );
    render(<MarkdownViewer tabId="t1" filePath="/note.md" />);
    fireEvent.click(await screen.findByText("ソース"));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "saved part" } });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
    });
    fireEvent.change(box, { target: { value: "saved part + typed while saving" } });
    await act(async () => { finishSave(); });

    expect(cmds.saveMarkdown).toHaveBeenCalledWith("/note.md", "saved part", "UTF-8");
    await waitFor(() => expect(useMarkdownStore.getState().tabs.t1.data?.raw).toBe("saved part"));
    expect(useMarkdownStore.getState().tabs.t1.isDirty).toBe(true);
    expect((box as HTMLTextAreaElement).value).toBe("saved part + typed while saving");
  });
});

describe("MarkdownViewer の分割プレビュー", () => {
  const md = (raw: string) => ({ html: "", toc: [], frontmatter: null, raw, encoding: "UTF-8" });

  beforeEach(() => {
    useMarkdownStore.setState({ tabs: {} });
    vi.clearAllMocks();
  });

  it("遅れて返ってきた古い描画結果で新しいプレビューを上書きしない", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const cmds = await import("../../lib/markdownCommands");
    vi.mocked(cmds.readMarkdown).mockResolvedValue(md("start"));
    const pending: Array<(html: string) => void> = [];
    vi.mocked(cmds.renderMarkdownString).mockImplementation(
      (content) =>
        new Promise((resolve) =>
          pending.push((html) => resolve({ ...md(content), html }))
        )
    );
    render(<MarkdownViewer tabId="t1" filePath="/note.md" />);
    fireEvent.click(await screen.findByText("分割"));
    const box = screen.getByRole("textbox");

    fireEvent.change(box, { target: { value: "first" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    fireEvent.change(box, { target: { value: "second" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // 新しい要求の結果が先に返り、古い要求の結果が後から返る
    await act(async () => { pending[pending.length - 1]("<p>second</p>"); });
    await act(async () => { pending[pending.length - 2]("<p>first</p>"); });

    expect(screen.getByTestId("rendered-view").innerHTML).toBe("<p>second</p>");
    vi.useRealTimers();
  });
});

describe("MarkdownViewer の既定の表示", () => {
  it("設定の「デフォルト表示」で開く", async () => {
    const { useSettingsStore } = await import("../../stores/settingsStore");
    const cmds = await import("../../lib/markdownCommands");
    useMarkdownStore.setState({ tabs: {} });
    useSettingsStore.setState({ markdownSettings: { defaultView: "source" } });
    vi.mocked(cmds.readMarkdown).mockResolvedValue({ html: "", toc: [], frontmatter: null, raw: "# hi", encoding: "UTF-8" });
    render(<MarkdownViewer tabId="t9" filePath="/note.md" />);
    expect(((await screen.findByRole("textbox")) as HTMLTextAreaElement).value).toBe("# hi");
    useSettingsStore.setState({ markdownSettings: { defaultView: "preview" } });
  });
});
