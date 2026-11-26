import { describe, it, expect } from "vitest";

describe("KaTeX auto-render (RenderedView と同じ読み込み方)", () => {
  it("$..$ と $$..$$ を数式に変換し、\\href などの trust が必要なコマンドは描画しない", async () => {
    const { default: renderMathInElement } = await import("katex/contrib/auto-render");
    const el = document.createElement("div");
    el.innerHTML = "<p>inline $x^2$ and</p><p>$$\\frac{a}{b}$$</p><p>$\\href{javascript:alert(1)}{x}$</p>";
    renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
    expect(el.querySelectorAll(".katex").length).toBe(3);
    expect(el.querySelector(".katex-display")).not.toBeNull();
    expect(el.querySelector("a[href], [href]")).toBeNull();
  });
});
