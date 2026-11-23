import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OutlineSidebar } from "../OutlineSidebar";
import type { OutlineItem } from "../../../types";

// OutlineItem is the normalized shape produced from pdf.js getOutline()
const flatOutline: OutlineItem[] = [
  { title: "第1章", page: 0, level: 0, children: [] },
  { title: "第2章", page: 4, level: 0, children: [] },
];

const nestedOutline: OutlineItem[] = [
  {
    title: "第1章",
    page: 0,
    level: 0,
    children: [
      { title: "1.1 節", page: 1, level: 1, children: [] },
      { title: "1.2 節", page: 2, level: 1, children: [] },
    ],
  },
];

describe("OutlineSidebar", () => {
  it("renders outline items", () => {
    render(
      <OutlineSidebar outlines={flatOutline} currentPage={1} onPageSelect={vi.fn()} />
    );
    expect(screen.getByText("第1章")).toBeInTheDocument();
    expect(screen.getByText("第2章")).toBeInTheDocument();
  });

  it("shows empty message when no outline", () => {
    render(
      <OutlineSidebar outlines={[]} currentPage={1} onPageSelect={vi.fn()} />
    );
    expect(screen.getByText("目次なし")).toBeInTheDocument();
  });

  it("calls onPageSelect with 1-based page on click", () => {
    const onPageSelect = vi.fn();
    render(
      <OutlineSidebar outlines={flatOutline} currentPage={1} onPageSelect={onPageSelect} />
    );
    fireEvent.click(screen.getByText("第2章"));
    expect(onPageSelect).toHaveBeenCalledWith(5); // page 4 (0-based) → 5 (1-based)
  });

  it("does not call onPageSelect when page is null", () => {
    const nullPageOutline: OutlineItem[] = [
      { title: "リンクなし", page: null, level: 0, children: [] },
    ];
    const onPageSelect = vi.fn();
    render(
      <OutlineSidebar outlines={nullPageOutline} currentPage={1} onPageSelect={onPageSelect} />
    );
    fireEvent.click(screen.getByText("リンクなし"));
    expect(onPageSelect).not.toHaveBeenCalled();
  });

  it("renders nested children", () => {
    render(
      <OutlineSidebar outlines={nestedOutline} currentPage={1} onPageSelect={vi.fn()} />
    );
    expect(screen.getByText("第1章")).toBeInTheDocument();
    expect(screen.getByText("1.1 節")).toBeInTheDocument();
    expect(screen.getByText("1.2 節")).toBeInTheDocument();
  });

  it("highlights the active item matching currentPage", () => {
    render(
      <OutlineSidebar outlines={flatOutline} currentPage={5} onPageSelect={vi.fn()} />
    );
    const activeItem = screen.getByText("第2章").closest("button");
    expect(activeItem).toHaveStyle({ color: "var(--text-primary)" });
  });
});
