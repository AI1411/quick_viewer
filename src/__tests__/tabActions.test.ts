import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore, type Tab } from "../stores/tabStore";
import { useMarkdownStore } from "../stores/markdownStore";
import { reloadTabFromDisk } from "../lib/tabActions";

const tab = (id: string, isDirty = false): Tab => ({
  id,
  title: `${id}.md`,
  filePath: `/${id}.md`,
  format: "markdown",
  isDirty,
  reloadCount: 0,
});

beforeEach(() => {
  useTabStore.setState({ tabs: [tab("a"), tab("b", true), tab("c")], activeTabId: "a" });
});

describe("reloadTabFromDisk", () => {
  beforeEach(() => {
    useMarkdownStore.setState({
      tabs: { b: { data: null, isLoading: false, error: null, viewMode: "source", editContent: "edited", isDirty: true } },
    });
  });

  it("未保存の編集を破棄してタブを再マウントさせる", () => {
    reloadTabFromDisk("b");
    expect(useMarkdownStore.getState().tabs.b).toMatchObject({ editContent: null, isDirty: false });
    expect(useTabStore.getState().tabs[1]).toMatchObject({ isDirty: false, reloadCount: 1 });
  });

  it("Markdown 以外のタブではストアにエントリを作らない", () => {
    reloadTabFromDisk("a");
    expect(useMarkdownStore.getState().tabs.a).toBeUndefined();
  });
});
