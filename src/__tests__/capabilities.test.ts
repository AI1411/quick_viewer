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
  "@tauri-apps/plugin-updater": {
    check: ["updater:allow-check", "updater:default"],
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

describe("tauri.conf.json の CSP", () => {
  it("IPC のカスタムプロトコルと、CSS に埋め込まれたフォントを遮断しない", async () => {
    const { default: conf } = await import("../../src-tauri/tauri.conf.json");
    const directives = Object.fromEntries(
      conf.app.security.csp.split(";").map((d: string) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values];
      })
    );
    // 無いと invoke が遅い postMessage 経路に落ちる (大きな画像や PDF の受け渡しで効く)
    expect(directives["connect-src"]).toEqual(expect.arrayContaining(["ipc:", "http://ipc.localhost"]));
    // Vite は小さなフォント (KaTeX_Size3) を data: URL で CSS に埋め込む
    expect(directives["font-src"]).toEqual(expect.arrayContaining(["'self'", "data:"]));
    expect(directives["script-src"]).toEqual(["'self'"]);
  });
});
