import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
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
vi.mock("../../lib/fileCommands", () => ({
  openFile: vi.fn().mockResolvedValue({ name: "別.md", path: "/docs/別.md", format: "markdown" }),
}));

import { join } from "@tauri-apps/api/path";
import { openFile } from "../../lib/fileCommands";
import { RenderedView } from "./RenderedView";

// pulldown-cmark が出力する形 (非 ASCII は %XX) の HTML を与える
const enc = encodeURIComponent;

function renderHtml(html: string) {
  const containerRef = createRef<HTMLDivElement>();
  const view = render(<RenderedView html={html} filePath="/docs/note.md" containerRef={containerRef} />);
  return { ...view, containerRef };
}

describe("RenderedView は %XX になった日本語のパスやアンカーを戻して使う", () => {
  beforeEach(() => vi.clearAllMocks());

  it("日本語ファイル名の画像", async () => {
    renderHtml(`<p><img src="${enc("図 1.png")}" alt=""></p>`);
    await waitFor(() => expect(join).toHaveBeenCalledWith("/docs", "図 1.png"));
  });

  it("日本語ファイル名の Markdown へのリンク", async () => {
    const { container } = renderHtml(`<p><a href="${enc("別")}.md">link</a></p>`);
    fireEvent.click(container.querySelector("a")!);
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("/docs/別.md"));
  });

  it("日本語の見出しへのアンカー", async () => {
    const { container } = renderHtml(`<h2 id="日本語見出し">日本語見出し</h2><p><a href="#${enc("日本語見出し")}">to</a></p>`);
    const heading = container.querySelector("h2")!;
    const scroll = vi.fn();
    heading.scrollIntoView = scroll;
    fireEvent.click(container.querySelector("a")!);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });
});
