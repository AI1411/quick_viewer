import { describe, it, expect, beforeEach } from "vitest";
import { usePdfStore } from "../pdfStore";

describe("pdfStore sidebarMode", () => {
  beforeEach(() => {
    usePdfStore.setState({ tabs: {} });
    usePdfStore.getState().initTab("t1");
  });

  it("defaults to thumbnail", () => {
    expect(usePdfStore.getState().tabs["t1"].sidebarMode).toBe("thumbnail");
  });

  it("setSidebarMode changes mode to outline", () => {
    usePdfStore.getState().setSidebarMode("t1", "outline");
    expect(usePdfStore.getState().tabs["t1"].sidebarMode).toBe("outline");
  });

  it("setSidebarMode changes mode back to thumbnail", () => {
    usePdfStore.getState().setSidebarMode("t1", "outline");
    usePdfStore.getState().setSidebarMode("t1", "thumbnail");
    expect(usePdfStore.getState().tabs["t1"].sidebarMode).toBe("thumbnail");
  });
});
