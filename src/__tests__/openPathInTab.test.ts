import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/fileCommands", () => ({
  openFile: vi.fn(async (path: string) => ({ path, name: path.split("/").pop(), format: "markdown", size: 1 })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { useTabStore } from "../stores/tabStore";
import { openPathInTab } from "../lib/openPathInTab";

beforeEach(() => useTabStore.setState({ tabs: [], activeTabId: null }));

describe("openPathInTab", () => {
  it("同じファイルを再度開くと新しいタブを作らず既存のタブに切り替える", async () => {
    await openPathInTab("/docs/a.md");
    await openPathInTab("/docs/b.md");
    const firstId = useTabStore.getState().tabs[0].id;

    await openPathInTab("/docs/a.md");

    expect(useTabStore.getState().tabs.map((t) => t.filePath)).toEqual(["/docs/a.md", "/docs/b.md"]);
    expect(useTabStore.getState().activeTabId).toBe(firstId);
  });
});
