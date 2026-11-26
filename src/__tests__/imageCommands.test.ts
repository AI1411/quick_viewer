import { describe, it, expect } from "vitest";
import rustLib from "../../src-tauri/src/lib.rs?raw";
import {
  IMAGE_EXTENSIONS,
  defaultOutputPath,
  formatBytes,
  formatChange,
  parentDir,
} from "../lib/imageCommands";
import type { ImageFormatSpec } from "../types";

const jpeg: ImageFormatSpec = {
  id: "jpeg",
  label: "JPEG",
  extensions: ["jpg", "jpeg"],
  mime: "image/jpeg",
  lossy: true,
  alpha: false,
  keeps_metadata: true,
};

describe("IMAGE_EXTENSIONS", () => {
  it("Rust 側 (lib.rs) の IMAGE_EXTENSIONS と同じ内容になっている", () => {
    const block = /IMAGE_EXTENSIONS: &\[&str\] = &\[([^\]]*)\]/.exec(rustLib)?.[1] ?? "";
    const rust = Array.from(block.matchAll(/"([a-z0-9]+)"/g), (m) => m[1]);
    expect(rust.length).toBeGreaterThan(10);
    expect([...IMAGE_EXTENSIONS].sort()).toEqual(rust.sort());
  });
});

describe("defaultOutputPath", () => {
  it("別の形式へは同じフォルダ・同じ名前で拡張子だけ変える", () => {
    expect(defaultOutputPath("/Users/me/Pictures/IMG_0001.HEIC", jpeg)).toBe("/Users/me/Pictures/IMG_0001.jpg");
  });

  it("同じ形式での再圧縮は元のファイルと別の名前にする", () => {
    expect(defaultOutputPath("/p/photo.jpeg", jpeg)).toBe("/p/photo-converted.jpg");
    expect(defaultOutputPath("/p/photo.JPG", jpeg)).toBe("/p/photo-converted.jpg");
  });
});

describe("表示用の整形", () => {
  it("formatBytes は単位を付ける", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(250 * 1024)).toBe("250 KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.50 MB");
  });

  it("formatChange は元のサイズからの増減を返す", () => {
    expect(formatChange(1000, 270)).toBe("-73%");
    expect(formatChange(1000, 1120)).toBe("+12%");
    expect(formatChange(0, 100)).toBe("");
  });

  it("parentDir はファイルのあるフォルダを返す", () => {
    expect(parentDir("/Users/me/Pictures/a.heic")).toBe("/Users/me/Pictures");
    expect(parentDir("/a.heic")).toBe("/");
  });
});
