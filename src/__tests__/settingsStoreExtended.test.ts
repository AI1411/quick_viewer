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

describe("parseSettings (保存された設定の検査)", () => {
  it("型の違う値や未知のキーは既定値に置き換え、正しい値だけを使う", async () => {
    const { parseSettings } = await import("../stores/settingsStore");
    const parsed = parseSettings({
      theme: "neon",
      zoomLevel: "huge",
      fontFamily: 42,
      setTheme: "not a function",
      csvSettings: { defaultDelimiter: ";" },
      pdfSettings: { defaultViewMode: "double" },
      markdownSettings: null,
    });
    expect(parsed).toEqual({
      theme: "system",
      zoomLevel: 14,
      fontFamily: "system-ui",
      csvSettings: { defaultDelimiter: ";" },
      pdfSettings: { defaultViewMode: "continuous" },
      markdownSettings: { defaultView: "preview" },
    });
    expect(parsed).not.toHaveProperty("setTheme");
  });

  it("ズームは範囲内に収める", async () => {
    const { parseSettings } = await import("../stores/settingsStore");
    expect(parseSettings({ zoomLevel: 999 }).zoomLevel).toBe(32);
  });
});
