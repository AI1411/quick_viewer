import { describe, it, expect } from "vitest";
import capability from "../../src-tauri/capabilities/default.json";

const sources = import.meta.glob(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/**/__tests__/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// フロントで呼ぶプラグイン関数ごとに、capabilities で必要な権限
const REQUIRED_PERMISSION: Record<string, Record<string, string[]>> = {
  "@tauri-apps/plugin-dialog": {
    open: ["dialog:allow-open", "dialog:default"],
    save: ["dialog:allow-save", "dialog:default"],
    message: ["dialog:allow-message", "dialog:default"],
    confirm: ["dialog:allow-message", "dialog:default"],
    ask: ["dialog:allow-message", "dialog:default"],
  },
  "@tauri-apps/plugin-opener": {
    openUrl: ["opener:allow-open-url", "opener:default"],
    openPath: ["opener:allow-open-path"],
    revealItemInDir: ["opener:allow-reveal-item-in-dir", "opener:default"],
  },
};

describe("capabilities/default.json", () => {
  it("フロントが呼ぶプラグイン関数の権限がすべて許可されている", () => {
    const missing: string[] = [];
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [file, code] of Object.entries(sources)) {
      for (const [pkg, fns] of Object.entries(REQUIRED_PERMISSION)) {
        const imports = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${pkg}"`).exec(code)?.[1] ?? "";
        for (const spec of imports.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          const accepted = fns[spec];
          if (accepted && !accepted.some((p) => capability.permissions.includes(p))) {
            missing.push(`${file}: ${pkg} の ${spec}() には ${accepted[0]} が必要`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
