import { useRef, useEffect } from "react";
import { useSearchStore } from "../stores/searchStore";

export function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const isOpen = useSearchStore((s) => s.isOpen);
  const query = useSearchStore((s) => s.query);
  const options = useSearchStore((s) => s.options);
  const matchCount = useSearchStore((s) => s.matchCount);
  const currentMatchIndex = useSearchStore((s) => s.currentMatchIndex);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  const { setQuery, setOptions, nextMatch, prevMatch, close } =
    useSearchStore.getState();

  const countLabel =
    matchCount > 0
      ? `${currentMatchIndex + 1} / ${matchCount}`
      : query
      ? "0 件"
      : "";

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0"
      style={{ backgroundColor: "var(--toolbar-bg)", borderColor: "var(--border-color)" }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) prevMatch();
            else nextMatch();
          }
          if (e.key === "Escape") close();
        }}
        placeholder="検索..."
        className="text-xs px-2 py-1 rounded border outline-none"
        style={{
          backgroundColor: "var(--viewer-bg)",
          color: "var(--text-primary)",
          borderColor: "var(--border-color)",
          width: 200,
        }}
      />
      <span
        className="text-xs select-none"
        style={{ color: "var(--text-secondary)", minWidth: 52 }}
      >
        {countLabel}
      </span>
      <button
        title="正規表現 (.*)"
        onClick={() => setOptions({ ...options, useRegex: !options.useRegex })}
        className="text-xs px-1.5 py-0.5 rounded border select-none"
        style={{
          borderColor: options.useRegex ? "#3b82f6" : "var(--border-color)",
          color: options.useRegex ? "#3b82f6" : "var(--text-secondary)",
          backgroundColor: options.useRegex ? "rgba(59,130,246,0.12)" : "transparent",
        }}
      >
        .*
      </button>
      <button
        title="大文字小文字区別 (Aa)"
        onClick={() =>
          setOptions({ ...options, caseSensitive: !options.caseSensitive })
        }
        className="text-xs px-1.5 py-0.5 rounded border select-none"
        style={{
          borderColor: options.caseSensitive ? "#3b82f6" : "var(--border-color)",
          color: options.caseSensitive ? "#3b82f6" : "var(--text-secondary)",
          backgroundColor: options.caseSensitive
            ? "rgba(59,130,246,0.12)"
            : "transparent",
        }}
      >
        Aa
      </button>
      <button
        onClick={prevMatch}
        disabled={matchCount === 0}
        title="前の一致 (Shift+Enter)"
        className="text-xs px-1.5 py-0.5 rounded select-none disabled:opacity-30"
        style={{ color: "var(--text-secondary)" }}
      >
        ↑
      </button>
      <button
        onClick={nextMatch}
        disabled={matchCount === 0}
        title="次の一致 (Enter)"
        className="text-xs px-1.5 py-0.5 rounded select-none disabled:opacity-30"
        style={{ color: "var(--text-secondary)" }}
      >
        ↓
      </button>
      <button
        onClick={close}
        title="閉じる (Esc)"
        className="text-xs px-1.5 py-0.5 rounded ml-auto select-none"
        style={{ color: "var(--text-secondary)" }}
      >
        ✕
      </button>
    </div>
  );
}
