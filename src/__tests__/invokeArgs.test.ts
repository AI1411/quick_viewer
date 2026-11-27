import { describe, it, expect } from "vitest";

const rustSources = import.meta.glob("/src-tauri/src/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const tsSources = import.meta.glob(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/**/__tests__/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 深さ 0 のカンマで分割する (ジェネリクスや入れ子の中のカンマでは分けない) */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("<([{".includes(ch)) depth++;
    else if (">)]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const toCamelCase = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** コマンド名 → フロントから渡せる引数名 (Tauri は Rust の引数名を camelCase にしたキーで受け取る) */
function rustCommandArgs(): Map<string, Set<string>> {
  const commands = new Map<string, Set<string>>();
  // コマンドの属性の後に #[allow(...)] などが続くことがある
  const pattern =
    /#\[tauri::command(?:\(async\))?\](?:\s*#\[[^\]]*\])*\s*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(([^)]*)\)/g;
  for (const source of Object.values(rustSources)) {
    for (const [, name, params] of source.matchAll(pattern)) {
      const args = splitTopLevel(params)
        .map((p) => [p.slice(0, p.indexOf(":")).trim(), p.slice(p.indexOf(":") + 1)])
        // State や AppHandle は Tauri が注入するので、フロントからは渡さない
        .filter(([, type]) => !/\b(State|AppHandle|Window|WebviewWindow)\b/.test(type))
        .map(([arg]) => toCamelCase(arg.replace(/^mut\s+/, "")));
      commands.set(name, new Set(args));
    }
  }
  return commands;
}

/** invoke("name", { ... }) のオブジェクトリテラル直下のキーを取り出す */
function invokeCalls(source: string): Array<{ command: string; keys: string[] }> {
  const calls: Array<{ command: string; keys: string[] }> = [];
  const pattern = /\binvoke(?:<[^(]*>)?\(\s*"(\w+)"\s*,\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    let depth = 1;
    let i = match.index + match[0].length;
    let body = "";
    while (i < source.length && depth > 0) {
      const ch = source[i++];
      if ("{([".includes(ch)) depth++;
      else if ("})]".includes(ch)) depth--;
      if (depth === 1 && !"})]".includes(ch)) body += ch;
    }
    const keys = splitTopLevel(body.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""'))
      .map((part) => /^(\w+)/.exec(part)?.[1])
      .filter((key): key is string => key !== undefined);
    calls.push({ command: match[1], keys });
  }
  return calls;
}

describe("invoke に渡す引数", () => {
  it("Rust のコマンドが受け取るキー (引数名の camelCase) だけを渡している", () => {
    const commands = rustCommandArgs();
    expect(commands.size).toBeGreaterThan(15);
    const wrong: string[] = [];
    let checked = 0;
    for (const [file, source] of Object.entries(tsSources)) {
      for (const { command, keys } of invokeCalls(source)) {
        const accepted = commands.get(command);
        if (!accepted) {
          wrong.push(`${file}: ${command} というコマンドは Rust 側にありません`);
          continue;
        }
        checked++;
        for (const key of keys) {
          if (!accepted.has(key)) {
            wrong.push(`${file}: ${command} は ${key} を受け取りません (受け取るのは ${[...accepted].join(", ")})`);
          }
        }
      }
    }
    // vitest は invoke をモックするので、キー名の食い違いは実機でしか失敗しない。ここで検出する
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(15);
  });
});
