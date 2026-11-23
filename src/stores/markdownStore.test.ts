import { describe, it, expect, beforeEach } from "vitest";
import { useMarkdownStore } from "./markdownStore";
import { useSettingsStore } from "./settingsStore";

const MOCK: import("../types").MarkdownResult = {
  html: "<h1 id=\"hello\">Hello</h1>",
  toc: [{ level: 1, text: "Hello", anchor: "hello" }],
  frontmatter: null,
  raw: "# Hello",
  encoding: "UTF-8",
};

describe("markdownStore", () => {
  beforeEach(() => {
    useMarkdownStore.setState({ tabs: {} });
    useSettingsStore.setState({
      markdownSettings: { defaultView: "preview" },
    });
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

describe("viewMode / editContent / isDirty", () => {
  beforeEach(() => {
    useMarkdownStore.setState({ tabs: {} });
    useSettingsStore.setState({
      markdownSettings: { defaultView: "preview" },
    });
  });

  it("initTab initializes viewMode from settings, editContent=null, isDirty=false", () => {
    useMarkdownStore.getState().initTab("e1");
    const tab = useMarkdownStore.getState().tabs["e1"];
    expect(tab.viewMode).toBe("preview");
    expect(tab.editContent).toBeNull();
    expect(tab.isDirty).toBe(false);
  });

  it("initTab uses markdownSettings.defaultView", () => {
    useSettingsStore.setState({ markdownSettings: { defaultView: "split" } });
    useMarkdownStore.getState().initTab("e1");
    expect(useMarkdownStore.getState().tabs["e1"].viewMode).toBe("split");
  });

  it("setViewMode updates viewMode", () => {
    useMarkdownStore.getState().initTab("e2");
    useMarkdownStore.getState().setViewMode("e2", "split");
    expect(useMarkdownStore.getState().tabs["e2"].viewMode).toBe("split");
  });

  it("setEditContent updates editContent", () => {
    useMarkdownStore.getState().initTab("e3");
    useMarkdownStore.getState().setEditContent("e3", "# Hello");
    expect(useMarkdownStore.getState().tabs["e3"].editContent).toBe("# Hello");
  });

  it("setDirty updates isDirty", () => {
    useMarkdownStore.getState().initTab("e4");
    useMarkdownStore.getState().setDirty("e4", true);
    expect(useMarkdownStore.getState().tabs["e4"].isDirty).toBe(true);
  });

  it("initTab is idempotent for new fields", () => {
    useMarkdownStore.getState().initTab("e5");
    useMarkdownStore.getState().setViewMode("e5", "source");
    useMarkdownStore.getState().initTab("e5");
    expect(useMarkdownStore.getState().tabs["e5"].viewMode).toBe("source");
  });
});
