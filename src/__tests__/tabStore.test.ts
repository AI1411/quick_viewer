import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../stores/tabStore";

describe("tabStore", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null });
  });

  it("addTab でタブが追加される", () => {
    const tab = { id: "1", title: "test.csv", filePath: "/tmp/test.csv" };
    useTabStore.getState().addTab(tab);
    expect(useTabStore.getState().tabs).toHaveLength(1);
    expect(useTabStore.getState().tabs[0]).toEqual(tab);
  });

  it("removeTab でタブが削除される", () => {
    const tab = { id: "1", title: "test.csv", filePath: "/tmp/test.csv" };
    useTabStore.getState().addTab(tab);
    useTabStore.getState().removeTab("1");
    expect(useTabStore.getState().tabs).toHaveLength(0);
  });

  it("setActiveTab でアクティブタブが変わる", () => {
    useTabStore.getState().setActiveTab("1");
    expect(useTabStore.getState().activeTabId).toBe("1");
  });
});
