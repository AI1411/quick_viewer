import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TitleBar } from "../components/TitleBar";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
  }),
}));

describe("TitleBar", () => {
  it("アプリタイトルを表示する", () => {
    render(<TitleBar />);
    expect(screen.getByText("QuickView")).toBeInTheDocument();
  });

  it("data-tauri-drag-region 属性を持つ", () => {
    const { container } = render(<TitleBar />);
    expect(
      container.querySelector("[data-tauri-drag-region]")
    ).toBeInTheDocument();
  });

  it("ウィンドウコントロールボタンが3つある", () => {
    render(<TitleBar />);
    expect(screen.getByTitle("閉じる")).toBeInTheDocument();
    expect(screen.getByTitle("最小化")).toBeInTheDocument();
    expect(screen.getByTitle("最大化")).toBeInTheDocument();
  });
});
