import { useState, useEffect, useRef } from "react";
import type { FilterCondition } from "../../types";

const FILTER_TYPES: Array<{ value: FilterCondition["filter_type"]; label: string }> = [
  { value: "contains", label: "含む" },
  { value: "exact", label: "完全一致" },
  { value: "starts_with", label: "前方一致" },
  { value: "regex", label: "正規表現" },
  { value: "gt", label: "より大きい (>)" },
  { value: "lt", label: "より小さい (<)" },
  { value: "gte", label: "以上 (>=)" },
  { value: "lte", label: "以下 (<=)" },
  { value: "eq_num", label: "数値一致 (=)" },
];

interface FilterPopoverProps {
  column: string;
  anchorRect: DOMRect;
  existing: FilterCondition | null;
  onApply: (cond: FilterCondition) => void;
  onClear: () => void;
  onClose: () => void;
}

export function FilterPopover({
  column,
  anchorRect,
  existing,
  onApply,
  onClear,
  onClose,
}: FilterPopoverProps) {
  const [filterType, setFilterType] = useState<FilterCondition["filter_type"]>(
    existing?.filter_type ?? "contains"
  );
  const [value, setValue] = useState(existing?.value ?? "");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const handleApply = () => {
    if (value.trim() === "") {
      onClear();
    } else {
      onApply({ column, filter_type: filterType, value: value.trim() });
    }
    onClose();
  };

  const handleClear = () => {
    onClear();
    onClose();
  };

  // ポップオーバーの位置: anchorRect の下、画面右端からはみ出さないよう調整
  const top = anchorRect.bottom + 4;
  const popoverWidth = 220;
  const left = Math.min(anchorRect.left, window.innerWidth - popoverWidth - 8);

  return (
    <div
      ref={ref}
      className="fixed z-50 rounded shadow-lg border p-3 flex flex-col gap-2"
      style={{
        top,
        left,
        width: popoverWidth,
        backgroundColor: "var(--tabbar-bg)",
        borderColor: "var(--border-color)",
        color: "var(--text-primary)",
      }}
    >
      <div className="text-xs font-medium truncate" style={{ color: "var(--text-secondary)" }}>
        フィルタ: {column}
      </div>
      <select
        className="text-xs rounded px-1 py-1 border outline-none"
        style={{
          backgroundColor: "var(--viewer-bg)",
          borderColor: "var(--border-color)",
          color: "var(--text-primary)",
        }}
        value={filterType}
        onChange={(e) => setFilterType(e.target.value as FilterCondition["filter_type"])}
      >
        {FILTER_TYPES.map((ft) => (
          <option key={ft.value} value={ft.value}>
            {ft.label}
          </option>
        ))}
      </select>
      <input
        className="text-xs rounded px-2 py-1 border outline-none"
        style={{
          backgroundColor: "var(--viewer-bg)",
          borderColor: "var(--border-color)",
          color: "var(--text-primary)",
        }}
        type="text"
        placeholder="値を入力..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleApply();
          if (e.key === "Escape") onClose();
        }}
        autoFocus
      />
      <div className="flex gap-2">
        <button
          className="flex-1 text-xs py-1 rounded font-medium"
          style={{ backgroundColor: "#3b82f6", color: "white" }}
          onClick={handleApply}
        >
          適用
        </button>
        <button
          className="text-xs py-1 px-2 rounded border"
          style={{ borderColor: "var(--border-color)", color: "var(--text-secondary)" }}
          onClick={handleClear}
        >
          クリア
        </button>
      </div>
    </div>
  );
}
