import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

import { confirm } from "@tauri-apps/plugin-dialog";
import { useTabStore, type Tab } from "../stores/tabStore";
import { useMarkdownStore } from "../stores/markdownStore";
import {
  reloadTabFromDisk,
  closeTab,
  closeOtherTabs,
  closeTabsToRight,
  confirmCloseAllTabs,
} from "../lib/tabActions";

const tab = (id: string, isDirty = false): Tab => ({
  id,
  title: `${id}.md`,
  filePath: `/${id}.md`,
  format: "markdown",
  isDirty,
  reloadCount: 0,
});
const ids = () => useTabStore.getState().tabs.map((t) => t.id);

beforeEach(() => {
  vi.mocked(confirm).mockReset();
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

describe("タブを閉じる前の未保存確認", () => {
  it("未保存のタブは確認でキャンセルすると閉じない", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await closeTab("b")).toBe(false);
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("未保存のタブは確認で OK すると閉じる", async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    expect(await closeTab("b")).toBe(true);
    expect(ids()).toEqual(["a", "c"]);
  });

  it("閉じたタブの Markdown の編集状態も破棄する", async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    useMarkdownStore.setState({
      tabs: { b: { data: null, isLoading: false, error: null, viewMode: "source", editContent: "x", isDirty: true } },
    });
    await closeTab("b");
    expect(useMarkdownStore.getState().tabs.b).toBeUndefined();
  });

  it("保存済みのタブは確認せずに閉じる", async () => {
    await closeTab("c");
    expect(confirm).not.toHaveBeenCalled();
    expect(ids()).toEqual(["a", "b"]);
  });

  it("「他を全て閉じる」も未保存タブがあれば確認し、キャンセルなら1枚も閉じない", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await closeOtherTabs("a");
    expect(ids()).toEqual(["a", "b", "c"]);

    vi.mocked(confirm).mockResolvedValue(true);
    await closeOtherTabs("c");
    expect(ids()).toEqual(["c"]);
    expect(useTabStore.getState().activeTabId).toBe("c");
  });

  it("「右側を全て閉じる」も未保存タブがあれば確認する", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await closeTabsToRight("a");
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("確認ダイアログを開けないときは編集を失わない側に倒す", async () => {
    vi.mocked(confirm).mockRejectedValue("dialog.message not allowed");
    expect(await closeTab("b")).toBe(false);
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("ウィンドウを閉じる前の確認は未保存タブが無ければ常に許可する", async () => {
    useTabStore.setState({ tabs: [tab("a"), tab("c")] });
    expect(await confirmCloseAllTabs()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
