import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * キーコンボの文字列形式: "cmd+key" | "cmd+shift+key" | "cmd+alt+key"
 * 例: "cmd+o", "cmd+w", "cmd+tab", "cmd+shift+tab", "cmd+1"
 *
 * "cmd" は metaKey (Mac) または ctrlKey (Windows/Linux) に対応する。
 */
export type ShortcutKey = string;
export type ShortcutMap = Record<ShortcutKey, (e: KeyboardEvent) => void>;

interface ParsedCombo {
  cmd: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  const cmd = parts.includes("cmd") || parts.includes("ctrl");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  const key = parts[parts.length - 1];
  return { cmd, shift, alt, key };
}

function matchesEvent(combo: ParsedCombo, e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (combo.cmd !== mod) return false;
  if (combo.shift !== e.shiftKey) return false;
  if (combo.alt !== e.altKey) return false;
  return e.key.toLowerCase() === combo.key;
}

/**
 * キーボードショートカットを登録する汎用フック。
 *
 * @param shortcuts キーコンボ文字列 → ハンドラ関数のマップ
 */
export function useShortcuts(shortcuts: ShortcutMap): void {
  const shortcutsRef = useRef(shortcuts);
  useLayoutEffect(() => {
    shortcutsRef.current = shortcuts;
  });

  useEffect(() => {
    // 押されたときの最新のハンドラを使う (初回描画時のハンドラに固定しない)
    function handleKeyDown(e: KeyboardEvent) {
      for (const [combo, handler] of Object.entries(shortcutsRef.current)) {
        if (matchesEvent(parseCombo(combo), e)) {
          e.preventDefault();
          handler(e);
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
