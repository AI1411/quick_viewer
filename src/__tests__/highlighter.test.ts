import { describe, it, expect } from "vitest";
import { getHighlighter } from "../lib/highlighter";

describe("getHighlighter", () => {
  it("WebAssembly を使わずにコードをハイライトできる", async () => {
    const realCompile = WebAssembly.compile;
    const realInstantiate = WebAssembly.instantiate;
    const blocked = () => Promise.reject(new Error("WebAssembly blocked by CSP"));
    WebAssembly.compile = blocked as typeof WebAssembly.compile;
    WebAssembly.instantiate = blocked as typeof WebAssembly.instantiate;
    try {
      const hl = await getHighlighter();
      const html = hl.codeToHtml("fn main() { let x = 1; }", { lang: "rust", theme: "github-light" });
      expect(html).toContain("<span");
      expect(html).toContain("main");
    } finally {
      WebAssembly.compile = realCompile;
      WebAssembly.instantiate = realInstantiate;
    }
  }, 20_000);
});
