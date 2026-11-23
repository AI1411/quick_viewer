import { describe, expect, it } from "vitest";
import { compareCellValues, tryParseEntireNumber } from "../compareCellValues";

describe("tryParseEntireNumber", () => {
  it("parses whole-string numbers including decimals and negatives", () => {
    expect(tryParseEntireNumber("1.5")).toBe(1.5);
    expect(tryParseEntireNumber("1.25")).toBe(1.25);
    expect(tryParseEntireNumber("-5")).toBe(-5);
    expect(tryParseEntireNumber("-10")).toBe(-10);
    expect(tryParseEntireNumber(" 9 ")).toBe(9);
  });

  it("rejects ISO dates and other partial-numeric strings", () => {
    expect(tryParseEntireNumber("2024-03-01")).toBeNull();
    expect(tryParseEntireNumber("2024-01-05")).toBeNull();
    expect(tryParseEntireNumber("10px")).toBeNull();
    expect(tryParseEntireNumber("")).toBeNull();
    expect(tryParseEntireNumber("abc")).toBeNull();
  });
});

describe("compareCellValues", () => {
  it("sorts decimals and negatives numerically", () => {
    const values = ["1.5", "1.25", "-5", "-10", "10", "9"];
    const sorted = [...values].sort(compareCellValues);
    expect(sorted).toEqual(["-10", "-5", "1.25", "1.5", "9", "10"]);
  });

  it("sorts ISO date strings lexicographically (date order)", () => {
    const values = ["2024-03-01", "2024-01-05", "2024-02-10"];
    const sorted = [...values].sort(compareCellValues);
    expect(sorted).toEqual(["2024-01-05", "2024-02-10", "2024-03-01"]);
  });

  it("falls back to string compare for non-numeric text", () => {
    const values = ["banana", "apple", "cherry"];
    const sorted = [...values].sort(compareCellValues);
    expect(sorted).toEqual(["apple", "banana", "cherry"]);
  });
});
