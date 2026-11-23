import { describe, expect, it } from "vitest";
import { classifyMarkdownHref } from "./RenderedView";

describe("classifyMarkdownHref", () => {
  it("classifies hash anchors", () => {
    expect(classifyMarkdownHref("#section-1")).toEqual({
      kind: "anchor",
      value: "section-1",
    });
  });

  it("classifies http(s) and mailto as external", () => {
    expect(classifyMarkdownHref("https://example.com").kind).toBe("external");
    expect(classifyMarkdownHref("http://example.com").kind).toBe("external");
    expect(classifyMarkdownHref("mailto:a@b.com").kind).toBe("external");
  });

  it("classifies relative markdown paths", () => {
    expect(classifyMarkdownHref("./other.md")).toEqual({
      kind: "markdown",
      value: "./other.md",
    });
    expect(classifyMarkdownHref("../docs/readme.markdown").kind).toBe("markdown");
  });

  it("treats other relative links as other", () => {
    expect(classifyMarkdownHref("./image.png").kind).toBe("other");
    expect(classifyMarkdownHref("/absolute/path").kind).toBe("other");
  });
});
