import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { showError } from "../../stores/toastStore";
import type { FilterCondition } from "../../types";

const FILTER_TYPE_LABELS: Record<FilterCondition["filter_type"], string> = {
  exact: "=",
  contains: "含む",
  starts_with: "前方",
  regex: "正規表現",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  eq_num: "=数",
};

interface ActiveFiltersBarProps {
  filters: FilterCondition[];
  filePath: string;
  onClearFilter: (column: string) => void;
  onClearAll: () => void;
  onExport?: () => Promise<void>;
}

export function ActiveFiltersBar({
  filters,
  filePath,
  onClearFilter,
  onClearAll,
  onExport,
}: ActiveFiltersBarProps) {
  if (filters.length === 0) return null;

  const handleExport = async () => {
    if (onExport) {
      await onExport();
      return;
    }
    try {
      const outputPath = await save({
        filters: [{ name: "CSV", extensions: ["csv"] }],
        defaultPath: "filtered.csv",
      });
      if (!outputPath) return;
      await invoke("export_csv", {
        path: filePath,
        outputPath,
        conditions: filters,
      });
    } catch (err) {
      showError(`CSV エクスポートに失敗しました: ${String(err)}`);
    }
  };

  return (
    <div
      className="flex items-center gap-2 px-3 flex-wrap flex-shrink-0"
      style={{
        minHeight: 32,
        paddingTop: 4,
        paddingBottom: 4,
        borderBottom: "1px solid var(--border-color)",
        backgroundColor: "var(--tabbar-bg)",
      }}
    >
      <span className="text-xs flex-shrink-0" style={{ color: "var(--text-secondary)" }}>
        フィルタ:
      </span>
      {filters.map((f) => (
        <div
          key={f.column}
          className="flex items-center gap-1 text-xs rounded px-2 py-0.5"
          style={{
            border: "1px solid #3b82f6",
            color: "#3b82f6",
            backgroundColor: "rgba(59,130,246,0.1)",
            flexShrink: 0,
          }}
        >
          <span className="max-w-32 truncate">
            {f.column} <span style={{ opacity: 0.7 }}>{FILTER_TYPE_LABELS[f.filter_type]}</span> &quot;{f.value}&quot;
          </span>
          <button
            className="ml-0.5 hover:opacity-60"
            onClick={() => onClearFilter(f.column)}
            aria-label={`${f.column} フィルタを削除`}
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 ml-auto flex-shrink-0">
        <button
          className="text-xs px-2 py-0.5 rounded border"
          style={{ borderColor: "var(--border-color)", color: "var(--text-secondary)" }}
          onClick={onClearAll}
        >
          全てクリア
        </button>
        <button
          className="text-xs px-2 py-0.5 rounded font-medium"
          style={{ backgroundColor: "#3b82f6", color: "white" }}
          onClick={handleExport}
        >
          CSVエクスポート
        </button>
      </div>
    </div>
  );
}
