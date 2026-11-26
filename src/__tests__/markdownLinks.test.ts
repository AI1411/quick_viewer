import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/openPathInTab", () => ({ openPathInTab: vi.fn().mockResolvedValue(undefined) }));

import { openUrl } from "@tauri-apps/plugin-opener";
import { openPathInTab } from "../lib/openPathInTab";
import { handleRenderedLinkClick, resolveMarkdownLink } from "../lib/markdownLinks";

const MD = "/Users/me/docs/README.md";

describe("resolveMarkdownLink", () => {
  it("相対の .md リンクは Markdown のディレクトリ基準の絶対パスになる", () => {
    expect(resolveMarkdownLink("guide/setup.md", MD)).toEqual({ kind: "file", path: "/Users/me/docs/guide/setup.md" });
    expect(resolveMarkdownLink("../data/sales%20Q1.csv#top", MD)).toEqual({ kind: "file", path: "/Users/me/data/sales Q1.csv" });
  });

  it("http(s)/mailto は外部リンク、それ以外のスキームは何もしない", () => {
    expect(resolveMarkdownLink("https://example.com/a", MD)).toEqual({ kind: "external", url: "https://example.com/a" });
    expect(resolveMarkdownLink("mailto:a@example.com", MD)).toEqual({ kind: "external", url: "mailto:a@example.com" });
    expect(resolveMarkdownLink("file:///etc/passwd", MD)).toEqual({ kind: "none" });
    expect(resolveMarkdownLink("ssh://host", MD)).toEqual({ kind: "none" });
  });

  it("# はページ内アンカー、対応外の拡張子は何もしない", () => {
    expect(resolveMarkdownLink("#インストール", MD)).toEqual({ kind: "anchor", id: "インストール" });
    expect(resolveMarkdownLink("images/logo.png", MD)).toEqual({ kind: "none" });
  });
});

describe("handleRenderedLinkClick", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    container.innerHTML = `
      <h2 id="usage">Usage</h2>
      <a id="ext" href="https://example.com">ext</a>
      <a id="rel" href="guide.md"><span id="inner">guide</span></a>
      <a id="anc" href="#usage">anchor</a>
      <map><area id="area" href="other.md"></map>`;
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  const click = (id: string) => {
    const e = { target: container.querySelector(`#${id}`), preventDefault: vi.fn() };
    handleRenderedLinkClick(e, container, MD);
    return e;
  };

  it("外部リンクは webview を遷移させず OS の既定アプリで開く", () => {
    const e = click("ext");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("相対 .md リンクは webview を遷移させず新しいタブで開く (子要素のクリックも対象)", () => {
    const e = click("inner");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openPathInTab).toHaveBeenCalledWith("/Users/me/docs/guide.md");
  });

  it("area 要素のリンクも横取りする", () => {
    const e = click("area");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openPathInTab).toHaveBeenCalledWith("/Users/me/docs/other.md");
  });

  it("アンカーはコンテナ内の見出しへスクロールする", () => {
    const heading = container.querySelector("#usage") as HTMLElement;
    heading.scrollIntoView = vi.fn();
    const e = click("anc");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(heading.scrollIntoView).toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("リンク以外のクリックは既定動作を止めない", () => {
    const e = click("usage");
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
