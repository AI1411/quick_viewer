import { describe, it, expect } from "vitest";
import { enqueueReload, nextReload } from "../lib/reloadQueue";

describe("reloadQueue", () => {
  it("ダイアログ表示中に届いた別ファイルの変更通知も順番に残す", () => {
    let q = enqueueReload([], { tabId: "a", filePath: "/a.md" });
    q = enqueueReload(q, { tabId: "b", filePath: "/b.csv" });
    q = enqueueReload(q, { tabId: "a", filePath: "/a.md" });
    expect(q.map((p) => p.tabId)).toEqual(["a", "b"]);
  });

  it("閉じたタブの通知は飛ばす", () => {
    const q = [
      { tabId: "a", filePath: "/a.md" },
      { tabId: "b", filePath: "/b.csv" },
    ];
    expect(nextReload(q, ["b", "c"])?.tabId).toBe("b");
    expect(nextReload(q, ["c"])).toBeNull();
  });
});
