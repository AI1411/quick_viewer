import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { save } from "@tauri-apps/plugin-dialog";
import { useToastStore } from "../../../stores/toastStore";
import { ActiveFiltersBar } from "../ActiveFiltersBar";

beforeEach(() => useToastStore.setState({ toasts: [] }));

describe("ActiveFiltersBar のエクスポート", () => {
  it("保存ダイアログを開けないときは黙って失敗せずトーストで知らせる", async () => {
    vi.mocked(save).mockRejectedValue("dialog.save not allowed");
    render(
      <ActiveFiltersBar
        filters={[{ column: "a", filter_type: "contains", value: "x" }]}
        filePath="/data.csv"
        onClearFilter={() => {}}
        onClearAll={() => {}}
      />
    );
    fireEvent.click(screen.getByText(/エクスポート/));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message).join()).toContain("dialog.save not allowed")
    );
  });
});
