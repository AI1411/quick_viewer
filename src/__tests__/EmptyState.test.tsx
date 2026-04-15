import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../components/EmptyState";

describe("EmptyState", () => {
  it("ファイルを開く案内を表示する", () => {
    render(<EmptyState />);
    expect(
      screen.getByText(/ファイルを開いてください/)
    ).toBeInTheDocument();
  });

  it("キーボードショートカットを表示する", () => {
    render(<EmptyState />);
    expect(screen.getByText(/⌘O/)).toBeInTheDocument();
  });

  it("ドラッグアンドドロップの案内を表示する", () => {
    render(<EmptyState />);
    expect(screen.getByText(/ドラッグ&ドロップ/)).toBeInTheDocument();
  });
});
