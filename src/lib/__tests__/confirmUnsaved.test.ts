import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

import { ask } from "@tauri-apps/plugin-dialog";
import { confirmCloseDirtyTabs, confirmUnsaved } from "../confirmUnsaved";

const askMock = vi.mocked(ask);

describe("confirmUnsaved", () => {
  beforeEach(() => {
    askMock.mockReset();
  });

  it("ask を await して結果を返す", async () => {
    askMock.mockResolvedValue(true);
    await expect(confirmUnsaved("notes.md")).resolves.toBe(true);
    expect(askMock).toHaveBeenCalledWith(
      "「notes.md」には未保存の変更があります。閉じますか？",
      { title: "未保存の変更", kind: "warning" }
    );
  });

  it("キャンセル時は false", async () => {
    askMock.mockResolvedValue(false);
    await expect(confirmUnsaved("a.md")).resolves.toBe(false);
  });
});

describe("confirmCloseDirtyTabs", () => {
  beforeEach(() => {
    askMock.mockReset();
  });

  it("dirty がなければ true（ダイアログなし）", async () => {
    await expect(confirmCloseDirtyTabs([])).resolves.toBe(true);
    expect(askMock).not.toHaveBeenCalled();
  });

  it("1件なら confirmUnsaved 相当のメッセージ", async () => {
    askMock.mockResolvedValue(true);
    await expect(confirmCloseDirtyTabs(["a.md"])).resolves.toBe(true);
    expect(askMock).toHaveBeenCalledWith(
      "「a.md」には未保存の変更があります。閉じますか？",
      expect.any(Object)
    );
  });

  it("複数件なら件数メッセージ", async () => {
    askMock.mockResolvedValue(false);
    await expect(confirmCloseDirtyTabs(["a.md", "b.md"])).resolves.toBe(false);
    expect(askMock).toHaveBeenCalledWith(
      "未保存の変更があるタブが 2 件あります。閉じますか？",
      { title: "未保存の変更", kind: "warning" }
    );
  });
});
