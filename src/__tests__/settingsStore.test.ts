import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../stores/settingsStore";

describe("settingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: "system",
      zoomLevel: 14,
    });
  });

  it("初期値が正しい", () => {
    const state = useSettingsStore.getState();
    expect(state.theme).toBe("system");
    expect(state.zoomLevel).toBe(14);
  });

  it("setTheme でテーマを変更できる", () => {
    useSettingsStore.getState().setTheme("dark");
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  it("setTheme で light に変更できる", () => {
    useSettingsStore.getState().setTheme("light");
    expect(useSettingsStore.getState().theme).toBe("light");
  });

  it("setZoomLevel でズームを変更できる", () => {
    useSettingsStore.getState().setZoomLevel(18);
    expect(useSettingsStore.getState().zoomLevel).toBe(18);
  });

  it("increaseZoom で 2px 増加する", () => {
    useSettingsStore.setState({ zoomLevel: 14 });
    useSettingsStore.getState().increaseZoom();
    expect(useSettingsStore.getState().zoomLevel).toBe(16);
  });

  it("decreaseZoom で 2px 減少する", () => {
    useSettingsStore.setState({ zoomLevel: 14 });
    useSettingsStore.getState().decreaseZoom();
    expect(useSettingsStore.getState().zoomLevel).toBe(12);
  });

  it("increaseZoom は 32 を超えない", () => {
    useSettingsStore.setState({ zoomLevel: 32 });
    useSettingsStore.getState().increaseZoom();
    expect(useSettingsStore.getState().zoomLevel).toBe(32);
  });

  it("decreaseZoom は 10 を下回らない", () => {
    useSettingsStore.setState({ zoomLevel: 10 });
    useSettingsStore.getState().decreaseZoom();
    expect(useSettingsStore.getState().zoomLevel).toBe(10);
  });

  it("resetZoom でデフォルト値 14 に戻る", () => {
    useSettingsStore.setState({ zoomLevel: 20 });
    useSettingsStore.getState().resetZoom();
    expect(useSettingsStore.getState().zoomLevel).toBe(14);
  });
});
