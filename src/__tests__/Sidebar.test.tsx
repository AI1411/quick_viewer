import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../components/Sidebar";

describe("Sidebar", () => {
  it("isOpen が true のとき表示される", () => {
    render(<Sidebar isOpen={true} />);
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });

  it("isOpen が false のとき表示されない", () => {
    const { container } = render(<Sidebar isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("見出しテキストを表示する", () => {
    render(<Sidebar isOpen={true} />);
    expect(screen.getByText("ファイル")).toBeInTheDocument();
  });
});
