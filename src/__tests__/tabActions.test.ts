import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../stores/tabStore";
import { useMarkdownStore } from "../stores/markdownStore";
import { reloadTabFromDisk } from "../lib/tabActions";

beforeEach(() => {
  useTabStore.setState({
    tabs: [{ id: "t1", title: "a.md", filePath: "/a.md", format: "markdown", isDirty: true, reloadCount: 0 }],
    activeTabId: "t1",
  });
  useMarkdownStore.setState({
    tabs: { t1: { data: null, isLoading: false, error: null, viewMode: "source", editContent: "edited", isDirty: true } },
  });
});

describe("reloadTabFromDisk", () => {
  it("未保存の編集を破棄してタブを再マウントさせる", () => {
    reloadTabFromDisk("t1");
    expect(useMarkdownStore.getState().tabs.t1).toMatchObject({ editContent: null, isDirty: false });
    expect(useTabStore.getState().tabs[0]).toMatchObject({ isDirty: false, reloadCount: 1 });
  });

  it("Markdown 以外のタブではストアにエントリを作らない", () => {
    useMarkdownStore.setState({ tabs: {} });
    reloadTabFromDisk("t1");
    expect(useMarkdownStore.getState().tabs.t1).toBeUndefined();
  });
});
