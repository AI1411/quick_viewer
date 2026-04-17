import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsStore } from "../stores/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const reset = () =>
  useSettingsStore.setState({
    theme: "system",
    zoomLevel: 14,
    fontFamily: "system-ui",
    csvSettings: { defaultDelimiter: "auto" },
    pdfSettings: { defaultViewMode: "continuous" },
    markdownSettings: { defaultView: "preview" },
  });

describe("settingsStore (extended)", () => {
  beforeEach(reset);

  it("fontFamily の初期値が system-ui", () => {
    expect(useSettingsStore.getState().fontFamily).toBe("system-ui");
  });

  it("setFontFamily でフォントが変わる", () => {
    useSettingsStore.getState().setFontFamily("monospace");
    expect(useSettingsStore.getState().fontFamily).toBe("monospace");
  });

  it("setCsvSettings で delimiter が変わる", () => {
    useSettingsStore.getState().setCsvSettings({ defaultDelimiter: "," });
    expect(useSettingsStore.getState().csvSettings.defaultDelimiter).toBe(",");
  });

  it("setPdfSettings で viewMode が変わる", () => {
    useSettingsStore.getState().setPdfSettings({ defaultViewMode: "single" });
    expect(useSettingsStore.getState().pdfSettings.defaultViewMode).toBe("single");
  });

  it("setMarkdownSettings で view が変わる", () => {
    useSettingsStore.getState().setMarkdownSettings({ defaultView: "split" });
    expect(useSettingsStore.getState().markdownSettings.defaultView).toBe("split");
  });
});
