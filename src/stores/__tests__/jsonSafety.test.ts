import { describe, it, expect } from "vitest";

const MAX_JSON_SIZE = 5 * 1024 * 1024;
const MAX_RECENT = 20;

function safeParseRecentFiles(raw: string) {
  if (raw.length > MAX_JSON_SIZE) throw new Error("JSON too large");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_RECENT);
}

describe("safeParseRecentFiles", () => {
  it("正常なJSONをパースする", () => {
    const data = [{ path: "/test.md", name: "test.md", format: "markdown", openedAt: "2024-01-01" }];
    const result = safeParseRecentFiles(JSON.stringify(data));
    expect(result).toHaveLength(1);
  });

  it("件数超過は MAX_RECENT 件に切り詰める", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ path: `/file${i}.md`, name: `file${i}.md`, format: "markdown", openedAt: "2024-01-01" }));
    const result = safeParseRecentFiles(JSON.stringify(data));
    expect(result).toHaveLength(MAX_RECENT);
  });

  it("5MB 超は例外をスローする", () => {
    const huge = '"' + "x".repeat(MAX_JSON_SIZE) + '"';
    expect(() => safeParseRecentFiles(huge)).toThrow("JSON too large");
  });
});
