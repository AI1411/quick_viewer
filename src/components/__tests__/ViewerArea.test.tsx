import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ViewerArea } from "../ViewerArea";
import { useTabStore } from "../../stores/tabStore";
import { useCsvStore } from "../../stores/csvStore";
import { usePdfStore } from "../../stores/pdfStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("mock")),
}));
vi.mock("../../lib/pdfLib", () => ({
  loadPdfDocument: vi.fn().mockRejectedValue(new Error("mock")),
}));

describe("ViewerArea", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null });
    useCsvStore.setState({ tabs: {} });
    usePdfStore.setState({ tabs: {} });
  });

  it("keeps inactive tab viewers mounted (hidden) so state can survive switches", () => {
    useTabStore.setState({
      tabs: [
        {
          id: "csv1",
          title: "a.csv",
          filePath: "/a.csv",
          format: "csv",
          isDirty: false,
          reloadCount: 0,
        },
        {
          id: "pdf1",
          title: "b.pdf",
          filePath: "/b.pdf",
          format: "pdf",
          isDirty: false,
          reloadCount: 0,
        },
      ],
      activeTabId: "csv1",
    });

    const { container, rerender } = render(<ViewerArea />);

    // Both viewers mount (loading text appears for each)
    expect(screen.getAllByText("読み込み中...").length).toBeGreaterThanOrEqual(1);

    const wrappers = container.querySelectorAll("[aria-hidden]");
    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]).toHaveAttribute("aria-hidden", "false");
    expect(wrappers[1]).toHaveAttribute("aria-hidden", "true");

    useTabStore.getState().setActiveTab("pdf1");
    rerender(<ViewerArea />);

    const after = container.querySelectorAll("[aria-hidden]");
    expect(after[0]).toHaveAttribute("aria-hidden", "true");
    expect(after[1]).toHaveAttribute("aria-hidden", "false");
    // Still two mounted wrappers (not unmounted)
    expect(after).toHaveLength(2);
  });

  it("clears viewer stores when a tab is closed via tabStore.removeTab", () => {
    useCsvStore.getState().initTab("csv1");
    usePdfStore.getState().initTab("pdf1");
    useTabStore.setState({
      tabs: [
        {
          id: "csv1",
          title: "a.csv",
          filePath: "/a.csv",
          format: "csv",
          isDirty: false,
          reloadCount: 0,
        },
        {
          id: "pdf1",
          title: "b.pdf",
          filePath: "/b.pdf",
          format: "pdf",
          isDirty: false,
          reloadCount: 0,
        },
      ],
      activeTabId: "csv1",
    });

    useTabStore.getState().removeTab("csv1");

    expect(useCsvStore.getState().tabs["csv1"]).toBeUndefined();
    expect(usePdfStore.getState().tabs["pdf1"]).toBeDefined();
  });
});
