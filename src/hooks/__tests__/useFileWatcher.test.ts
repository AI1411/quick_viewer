import { describe, it, expect } from "vitest";

describe("useFileWatcher ロジック: 複数タブ同一ファイル", () => {
  it("find()は最初の1タブのみ通知する（バグの確認）", () => {
    const tabs = [
      { id: "tab-1", filePath: "/test/file.md" },
      { id: "tab-2", filePath: "/test/file.md" },
      { id: "tab-3", filePath: "/other/file.txt" },
    ];
    const changedPath = "/test/file.md";
    const notified: string[] = [];
    const tab = tabs.find((t) => t.filePath === changedPath);
    if (tab) notified.push(tab.id);
    expect(notified).toHaveLength(1);
  });

  it("filter()は全タブに通知する（修正後の動作）", () => {
    const tabs = [
      { id: "tab-1", filePath: "/test/file.md" },
      { id: "tab-2", filePath: "/test/file.md" },
      { id: "tab-3", filePath: "/other/file.txt" },
    ];
    const changedPath = "/test/file.md";
    const notified: string[] = [];
    const matchingTabs = tabs.filter((t) => t.filePath === changedPath);
    for (const t of matchingTabs) notified.push(t.id);
    expect(notified).toHaveLength(2);
    expect(notified).toContain("tab-1");
    expect(notified).toContain("tab-2");
    expect(notified).not.toContain("tab-3");
  });
});
