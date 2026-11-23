import { describe, it, expect, beforeEach } from "vitest";
import { useCsvStore } from "../csvStore";

describe("csvStore filter actions", () => {
  beforeEach(() => {
    useCsvStore.setState({ tabs: {} });
  });

  it("setFilters: filters と filteredRows を更新し isFiltering を false にする", () => {
    useCsvStore.getState().initTab("t1");
    useCsvStore.getState().setFilters(
      "t1",
      [{ column: "name", filter_type: "contains", value: "foo" }],
      [["foo"]]
    );
    const tab = useCsvStore.getState().tabs["t1"];
    expect(tab.filters).toHaveLength(1);
    expect(tab.filteredRows).toEqual([["foo"]]);
    expect(tab.isFiltering).toBe(false);
  });

  it("clearFilters: filters・filteredRows・isFiltering をリセットする", () => {
    useCsvStore.getState().initTab("t2");
    useCsvStore.getState().setFilters(
      "t2",
      [{ column: "x", filter_type: "exact", value: "bar" }],
      [["bar"]]
    );
    useCsvStore.getState().clearFilters("t2");
    const tab = useCsvStore.getState().tabs["t2"];
    expect(tab.filters).toEqual([]);
    expect(tab.filteredRows).toBeNull();
    expect(tab.isFiltering).toBe(false);
  });

  it("setFiltering: isFiltering フラグを更新する", () => {
    useCsvStore.getState().initTab("t3");
    useCsvStore.getState().setFiltering("t3", true);
    expect(useCsvStore.getState().tabs["t3"].isFiltering).toBe(true);
    useCsvStore.getState().setFiltering("t3", false);
    expect(useCsvStore.getState().tabs["t3"].isFiltering).toBe(false);
  });

  it("setSortedRows / clearSortedRows: ソート結果を保持・クリアする", () => {
    useCsvStore.getState().initTab("t4");
    useCsvStore.getState().setSortedRows("t4", [["z"], ["a"]]);
    expect(useCsvStore.getState().tabs["t4"].sortedRows).toEqual([["z"], ["a"]]);
    expect(useCsvStore.getState().tabs["t4"].isSorting).toBe(false);
    useCsvStore.getState().clearSortedRows("t4");
    expect(useCsvStore.getState().tabs["t4"].sortedRows).toBeNull();
  });

  it("setSort(null): sortedRows もクリアする", () => {
    useCsvStore.getState().initTab("t5");
    useCsvStore.getState().setSort("t5", { columnIndex: 0, direction: "asc" });
    useCsvStore.getState().setSortedRows("t5", [["a"]]);
    useCsvStore.getState().setSort("t5", null);
    const tab = useCsvStore.getState().tabs["t5"];
    expect(tab.sort).toBeNull();
    expect(tab.sortedRows).toBeNull();
  });
});
