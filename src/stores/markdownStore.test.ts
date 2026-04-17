import { describe, it, expect, beforeEach } from "vitest";
import { useMarkdownStore } from "./markdownStore";

const MOCK: import("../types").MarkdownResult = {
  html: "<h1 id=\"hello\">Hello</h1>",
  toc: [{ level: 1, text: "Hello", anchor: "hello" }],
  frontmatter: null,
  raw: "# Hello",
};

describe("markdownStore", () => {
  beforeEach(() => {
    useMarkdownStore.setState({ tabs: {} });
  });

  it("initTab creates blank entry", () => {
    useMarkdownStore.getState().initTab("t1");
    const tab = useMarkdownStore.getState().tabs["t1"];
    expect(tab).toBeDefined();
    expect(tab.data).toBeNull();
    expect(tab.isLoading).toBe(false);
    expect(tab.error).toBeNull();
  });

  it("initTab is idempotent", () => {
    useMarkdownStore.getState().initTab("t1");
    useMarkdownStore.getState().setLoading("t1", true);
    useMarkdownStore.getState().initTab("t1");
    expect(useMarkdownStore.getState().tabs["t1"].isLoading).toBe(true);
  });

  it("setData updates data", () => {
    useMarkdownStore.getState().initTab("t1");
    useMarkdownStore.getState().setData("t1", MOCK);
    expect(useMarkdownStore.getState().tabs["t1"].data).toEqual(MOCK);
  });

  it("setLoading toggles loading", () => {
    useMarkdownStore.getState().initTab("t1");
    useMarkdownStore.getState().setLoading("t1", true);
    expect(useMarkdownStore.getState().tabs["t1"].isLoading).toBe(true);
  });

  it("setError sets error string", () => {
    useMarkdownStore.getState().initTab("t1");
    useMarkdownStore.getState().setError("t1", "read failed");
    expect(useMarkdownStore.getState().tabs["t1"].error).toBe("read failed");
  });

  it("removeTab deletes tab entry", () => {
    useMarkdownStore.getState().initTab("t1");
    useMarkdownStore.getState().removeTab("t1");
    expect(useMarkdownStore.getState().tabs["t1"]).toBeUndefined();
  });
});
