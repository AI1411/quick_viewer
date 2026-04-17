import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRecentFilesStore } from "../stores/recentFilesStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const reset = () => useRecentFilesStore.setState({ recentFiles: [] });

describe("recentFilesStore", () => {
  beforeEach(reset);

  it("addRecentFile でファイルが追加される", () => {
    useRecentFilesStore.getState().addRecentFile({
      path: "/tmp/a.csv",
      name: "a.csv",
      format: "csv",
      openedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useRecentFilesStore.getState().recentFiles).toHaveLength(1);
    expect(useRecentFilesStore.getState().recentFiles[0].path).toBe("/tmp/a.csv");
  });

  it("同じパスを追加すると先頭に移動して重複しない", () => {
    const add = useRecentFilesStore.getState().addRecentFile;
    add({ path: "/tmp/a.csv", name: "a.csv", format: "csv", openedAt: "2026-01-01T00:00:00.000Z" });
    add({ path: "/tmp/b.csv", name: "b.csv", format: "csv", openedAt: "2026-01-02T00:00:00.000Z" });
    add({ path: "/tmp/a.csv", name: "a.csv", format: "csv", openedAt: "2026-01-03T00:00:00.000Z" });
    const files = useRecentFilesStore.getState().recentFiles;
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("/tmp/a.csv");
  });

  it("21 件目追加で古いファイルが消える", () => {
    const add = useRecentFilesStore.getState().addRecentFile;
    for (let i = 0; i < 21; i++) {
      add({ path: `/tmp/file${i}.csv`, name: `file${i}.csv`, format: "csv", openedAt: "" });
    }
    expect(useRecentFilesStore.getState().recentFiles).toHaveLength(20);
    expect(useRecentFilesStore.getState().recentFiles[0].path).toBe("/tmp/file20.csv");
  });

  it("clearRecentFiles で空になる", () => {
    useRecentFilesStore.getState().addRecentFile({ path: "/tmp/x.csv", name: "x.csv", format: "csv", openedAt: "" });
    useRecentFilesStore.getState().clearRecentFiles();
    expect(useRecentFilesStore.getState().recentFiles).toHaveLength(0);
  });
});
