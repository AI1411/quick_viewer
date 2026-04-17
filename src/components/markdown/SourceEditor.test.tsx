import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SourceEditor } from "./SourceEditor";

describe("SourceEditor", () => {
  it("renders textarea with provided content", () => {
    render(<SourceEditor content="# Hello World" onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Hello World");
  });

  it("calls onChange when content is modified", () => {
    const onChange = vi.fn();
    render(<SourceEditor content="" onChange={onChange} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "# Updated" } });
    expect(onChange).toHaveBeenCalledWith("# Updated");
  });

  it("sets spellCheck attribute to false", () => {
    render(<SourceEditor content="" onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.getAttribute("spellcheck")).toBe("false");
  });
});
