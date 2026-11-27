import { describe, it, expect, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { createRef } from "react";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
vi.mock("../../lib/highlighter", () => ({ getHighlighter: vi.fn().mockRejectedValue(new Error("skip")) }));
vi.mock("katex/contrib/auto-render", () => ({ default: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://localhost${p}` }));
vi.mock("@tauri-apps/api/path", () => ({
  dirname: vi.fn(async (p: string) => p.slice(0, p.lastIndexOf("/"))),
  join: vi.fn(async (a: string, b: string) => `${a}/${b}`),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { RenderedView } from "./RenderedView";

describe("RenderedView の後処理", () => {
  it("書き換えた本文が、後処理の完了に伴う再描画で元の HTML に戻らない", async () => {
    const { container } = render(
      <RenderedView html={'<p><img src="a.png" alt=""></p>'} filePath="/docs/note.md" containerRef={createRef()} />
    );
    const src = () => container.querySelector("img")?.getAttribute("src");

    await waitFor(() => expect(src()).toBe("asset://localhost/docs/a.png"));
    // 後処理は最後に state を更新して再描画させる。その再描画が済むまで待つ
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(src()).toBe("asset://localhost/docs/a.png");
  });
});
