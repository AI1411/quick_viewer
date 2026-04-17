import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SplitView } from "./SplitView";

vi.mock("./RenderedView", () => ({
  RenderedView: ({
    html,
    containerRef,
  }: {
    html: string;
    containerRef: React.RefObject<HTMLDivElement | null>;
    filePath: string;
    onScroll?: () => void;
  }) => (
    <div ref={containerRef} data-testid="rendered-view">
      {html}
    </div>
  ),
}));

describe("SplitView", () => {
  it("renders SourceEditor and RenderedView", () => {
    render(
      <SplitView
        content="# Hello"
        html="<h1>Hello</h1>"
        filePath="/test.md"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByTestId("rendered-view")).toBeInTheDocument();
  });

  it("passes content to SourceEditor textarea", () => {
    render(
      <SplitView
        content="# Test Content"
        html=""
        filePath="/test.md"
        onChange={vi.fn()}
      />
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Test Content");
  });

  it("passes html to RenderedView", () => {
    render(
      <SplitView
        content=""
        html="<h1>Preview</h1>"
        filePath="/test.md"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId("rendered-view").textContent).toBe(
      "<h1>Preview</h1>"
    );
  });
});
