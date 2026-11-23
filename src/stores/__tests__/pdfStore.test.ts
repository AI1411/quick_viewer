import { describe, it, expect, beforeEach } from "vitest";
import { usePdfStore } from "../pdfStore";
import { useSettingsStore } from "../settingsStore";

beforeEach(() => {
  usePdfStore.setState({ tabs: {} });
  useSettingsStore.setState({
    pdfSettings: { defaultViewMode: "continuous" },
  });
});

describe("pdfStore", () => {
  it("initTab creates default state", () => {
    usePdfStore.getState().initTab("tab1");
    const state = usePdfStore.getState().tabs["tab1"];
    expect(state).toBeDefined();
    expect(state.currentPage).toBe(1);
    expect(state.zoom).toBe(1.0);
    expect(state.rotation).toBe(0);
    expect(state.displayMode).toBe("continuous");
    expect(state.isSidebarOpen).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.pdfInfo).toBeNull();
    expect(state.pdfDocument).toBeNull();
  });

  it("initTab uses pdfSettings.defaultViewMode", () => {
    useSettingsStore.setState({ pdfSettings: { defaultViewMode: "single" } });
    usePdfStore.getState().initTab("tab1");
    expect(usePdfStore.getState().tabs["tab1"].displayMode).toBe("single");
  });

  it("setCurrentPage updates page", () => {
    usePdfStore.getState().initTab("tab1");
    usePdfStore.getState().setCurrentPage("tab1", 3);
    expect(usePdfStore.getState().tabs["tab1"].currentPage).toBe(3);
  });

  it("setZoom clamps to [0.25, 4.0]", () => {
    usePdfStore.getState().initTab("tab1");
    usePdfStore.getState().setZoom("tab1", 0.1);
    expect(usePdfStore.getState().tabs["tab1"].zoom).toBe(0.25);
    usePdfStore.getState().setZoom("tab1", 10.0);
    expect(usePdfStore.getState().tabs["tab1"].zoom).toBe(4.0);
  });

  it("setRotation wraps at 360", () => {
    usePdfStore.getState().initTab("tab1");
    usePdfStore.getState().setRotation("tab1", 360);
    expect(usePdfStore.getState().tabs["tab1"].rotation).toBe(0);
    usePdfStore.getState().setRotation("tab1", 270);
    expect(usePdfStore.getState().tabs["tab1"].rotation).toBe(270);
  });

  it("removeTab deletes tab state", () => {
    usePdfStore.getState().initTab("tab1");
    usePdfStore.getState().removeTab("tab1");
    expect(usePdfStore.getState().tabs["tab1"]).toBeUndefined();
  });

  it("toggleSidebar flips isSidebarOpen", () => {
    usePdfStore.getState().initTab("tab1");
    expect(usePdfStore.getState().tabs["tab1"].isSidebarOpen).toBe(true);
    usePdfStore.getState().toggleSidebar("tab1");
    expect(usePdfStore.getState().tabs["tab1"].isSidebarOpen).toBe(false);
  });
});
