import { describe, it, expect } from "vitest";
// @ts-expect-error リリース用の Node スクリプト (型定義なし)
import { buildManifest } from "../../scripts/update-manifest.mjs";

describe("scripts/update-manifest.mjs", () => {
  it("Rust 側のテストでアップデータが読めると確認した形の latest.json を作る", () => {
    const manifest = buildManifest({
      version: "2.0.1",
      repository: "AI1411/quick_viewer",
      tag: "v2.0.1",
      pubDate: "2026-11-26T14:14:33.123Z",
    });
    expect(manifest).toEqual({
      version: "2.0.1",
      notes: "https://github.com/AI1411/quick_viewer/releases/tag/v2.0.1",
      pub_date: "2026-11-26T14:14:33Z",
      platforms: {
        "darwin-aarch64": {
          url: "https://github.com/AI1411/quick_viewer/releases/download/v2.0.1/QuickView_2.0.1_aarch64.dmg",
          signature: "",
        },
      },
    });
  });
});
