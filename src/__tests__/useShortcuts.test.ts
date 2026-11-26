import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useShortcuts } from "../hooks/useShortcuts";

describe("useShortcuts", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(window, "addEventListener");
    removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("window に keydown リスナーを登録する", () => {
    const shortcuts = { "cmd+o": vi.fn() };
    renderHook(() => useShortcuts(shortcuts));
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function)
    );
  });

  it("アンマウント時に keydown リスナーを解除する", () => {
    const shortcuts = { "cmd+o": vi.fn() };
    const { unmount } = renderHook(() => useShortcuts(shortcuts));
    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function)
    );
  });

  it("Cmd+O に対応するハンドラを呼ぶ", () => {
    const handler = vi.fn();
    renderHook(() => useShortcuts({ "cmd+o": handler }));
    const event = new KeyboardEvent("keydown", {
      key: "o",
      metaKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+O (Windows) にも対応する", () => {
    const handler = vi.fn();
    renderHook(() => useShortcuts({ "cmd+o": handler }));
    const event = new KeyboardEvent("keydown", {
      key: "o",
      ctrlKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Shift+Tab に対応するハンドラを呼ぶ", () => {
    const handler = vi.fn();
    renderHook(() => useShortcuts({ "cmd+shift+tab": handler }));
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("マッチしないキーではハンドラを呼ばない", () => {
    const handler = vi.fn();
    renderHook(() => useShortcuts({ "cmd+o": handler }));
    const event = new KeyboardEvent("keydown", {
      key: "p",
      metaKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
  });

  it("mod なしではハンドラを呼ばない", () => {
    const handler = vi.fn();
    renderHook(() => useShortcuts({ "cmd+o": handler }));
    const event = new KeyboardEvent("keydown", { key: "o", bubbles: true });
    window.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
  });

  it("Cmd+Tab に対応するハンドラを呼ぶ", () => {
    const handler = vi.fn();
    renderHook(() => useShortcuts({ "cmd+tab": handler }));
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      metaKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("useShortcuts のハンドラ更新", () => {
  it("再描画で渡されたハンドラやショートカットの追加を使う", () => {
    const first = vi.fn();
    const second = vi.fn();
    const added = vi.fn();
    const { rerender } = renderHook(({ map }) => useShortcuts(map), {
      initialProps: { map: { "cmd+o": first } as Record<string, (e: KeyboardEvent) => void> },
    });
    rerender({ map: { "cmd+o": second, "cmd+k": added } });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", metaKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenCalledTimes(1);
  });
});
