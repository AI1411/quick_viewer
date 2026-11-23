import { describe, it, expect, beforeEach } from "vitest";
import { cleanupTabStores } from "../cleanupTabStores";
import { useCsvStore } from "../../stores/csvStore";
import { usePdfStore } from "../../stores/pdfStore";
import { useXlsxStore } from "../../stores/xlsxStore";
import { useMarkdownStore } from "../../stores/markdownStore";

describe("cleanupTabStores", () => {
  beforeEach(() => {
    useCsvStore.setState({ tabs: {} });
    usePdfStore.setState({ tabs: {} });
    useXlsxStore.setState({ tabs: {} });
    useMarkdownStore.setState({ tabs: {} });
  });

  it("removes tab state from all viewer stores including markdown", () => {
    useCsvStore.getState().initTab("t1");
    usePdfStore.getState().initTab("t1");
    useXlsxStore.getState().initTab("t1");
    useMarkdownStore.getState().initTab("t1");

    cleanupTabStores("t1");

    expect(useCsvStore.getState().tabs["t1"]).toBeUndefined();
    expect(usePdfStore.getState().tabs["t1"]).toBeUndefined();
    expect(useXlsxStore.getState().tabs["t1"]).toBeUndefined();
    expect(useMarkdownStore.getState().tabs["t1"]).toBeUndefined();
  });
});
