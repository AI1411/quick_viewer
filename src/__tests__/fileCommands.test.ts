import { describe, it, expect, vi, beforeEach } from "vitest";

// @tauri-apps/api/core と @tauri-apps/plugin-dialog をモック
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openFile, showOpenDialog } from "../lib/fileCommands";

const mockInvoke = vi.mocked(invoke);
const mockOpenDialog = vi.mocked(openDialog);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openFile", () => {
  it("invoke open_file を呼び出して FileInfo を返す", async () => {
    const expected = {
      path: "/tmp/data.csv",
      name: "data.csv",
      format: "csv" as const,
      size: 1024,
    };
    mockInvoke.mockResolvedValue(expected);

    const result = await openFile("/tmp/data.csv");

    expect(mockInvoke).toHaveBeenCalledWith("open_file", {
      path: "/tmp/data.csv",
    });
    expect(result).toEqual(expected);
  });
});

describe("showOpenDialog", () => {
  it("ダイアログが文字列を返した場合そのまま返す", async () => {
    mockOpenDialog.mockResolvedValue("/tmp/data.csv");

    const result = await showOpenDialog();

    expect(result).toBe("/tmp/data.csv");
  });

  it("ダイアログが配列を返した場合最初の要素を返す", async () => {
    mockOpenDialog.mockResolvedValue(["/tmp/a.csv", "/tmp/b.csv"]);

    const result = await showOpenDialog();

    expect(result).toBe("/tmp/a.csv");
  });

  it("ダイアログがキャンセルされた場合 null を返す", async () => {
    mockOpenDialog.mockResolvedValue(null);

    const result = await showOpenDialog();

    expect(result).toBeNull();
  });
});
