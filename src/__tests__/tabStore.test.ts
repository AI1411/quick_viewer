import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../stores/tabStore";

describe("tabStore", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null });
  });

  it("addTab でタブが追加される", () => {
    const tab = { id: "1", title: "test.csv", filePath: "/tmp/test.csv", isDirty: false, reloadCount: 0 };
    useTabStore.getState().addTab(tab);
    expect(useTabStore.getState().tabs).toHaveLength(1);
    expect(useTabStore.getState().tabs[0]).toEqual(tab);
  });

  it("removeTab でタブが削除される", () => {
    const tab = { id: "1", title: "test.csv", filePath: "/tmp/test.csv", isDirty: false, reloadCount: 0 };
    useTabStore.getState().addTab(tab);
    useTabStore.getState().removeTab("1");
    expect(useTabStore.getState().tabs).toHaveLength(0);
  });

  it("setActiveTab でアクティブタブが変わる", () => {
    useTabStore.getState().setActiveTab("1");
    expect(useTabStore.getState().activeTabId).toBe("1");
  });
});

describe("reorderTabs", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null });
  });

  it("指定インデックスにタブを移動できる", () => {
    const { addTab, reorderTabs } = useTabStore.getState();
    addTab({ id: "a", title: "A", filePath: "/a.csv", isDirty: false, reloadCount: 0 });
    addTab({ id: "b", title: "B", filePath: "/b.csv", isDirty: false, reloadCount: 0 });
    addTab({ id: "c", title: "C", filePath: "/c.csv", isDirty: false, reloadCount: 0 });
    reorderTabs("a", 2);
    const { tabs } = useTabStore.getState();
    expect(tabs.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("removeTab - active tab handling", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null });
  });

  it("アクティブなタブを閉じたとき左隣タブがアクティブになる", () => {
    const { addTab, removeTab, setActiveTab } = useTabStore.getState();
    addTab({ id: "a", title: "A", filePath: "/a.csv", isDirty: false, reloadCount: 0 });
    addTab({ id: "b", title: "B", filePath: "/b.csv", isDirty: false, reloadCount: 0 });
    setActiveTab("b");
    removeTab("b");
    expect(useTabStore.getState().activeTabId).toBe("a");
  });

  it("最後のタブを閉じたとき activeTabId が null になる", () => {
    const { addTab, removeTab, setActiveTab } = useTabStore.getState();
    addTab({ id: "a", title: "A", filePath: "/a.csv", isDirty: false, reloadCount: 0 });
    setActiveTab("a");
    removeTab("a");
    expect(useTabStore.getState().activeTabId).toBeNull();
  });
});

describe("setDirty", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null });
  });

  it("タブの isDirty を更新できる", () => {
    const { addTab, setDirty } = useTabStore.getState();
    addTab({ id: "a", title: "A", filePath: "/a.csv", isDirty: false, reloadCount: 0 });
    setDirty("a", true);
    expect(useTabStore.getState().tabs[0].isDirty).toBe(true);
  });
});
