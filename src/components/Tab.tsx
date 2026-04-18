import { useRef } from "react";
import type { Tab } from "../stores/tabStore";

interface TabProps {
  tab: Tab;
  isActive: boolean;
  index: number;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;
  onDragStart: (e: React.DragEvent, tabId: string) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, index: number) => void;
}

function getFileIcon(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "csv":
    case "tsv":
      return "⊞";
    case "pdf":
      return "⬜";
    case "md":
    case "markdown":
      return "✎";
    case "xlsx":
    case "xls":
      return "⊞";
    default:
      return "◻";
  }
}

export function Tab({
  tab,
  isActive,
  index,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
}: TabProps) {
  const tabRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      // ミドルクリックで閉じる
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={tabRef}
      className="relative flex items-center h-full px-3 gap-1.5 cursor-pointer select-none shrink-0 group border-r"
      style={{
        maxWidth: "200px",
        minWidth: "80px",
        backgroundColor: isActive
          ? "var(--viewer-bg)"
          : "var(--tabbar-bg)",
        borderColor: "var(--border-color)",
        borderTop: isActive ? "1px solid var(--accent, #007acc)" : "none",
        color: isActive
          ? "var(--text-primary)"
          : "var(--text-secondary, #858585)",
      }}
      title={tab.filePath}
      draggable
      onClick={onActivate}
      onMouseDown={handleMouseDown}
      onContextMenu={(e) => onContextMenu(e, tab.id)}
      onDragStart={(e) => onDragStart(e, tab.id)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
    >
      {/* ファイルアイコン */}
      <span className="text-xs opacity-70">{getFileIcon(tab.filePath)}</span>

      {/* ファイル名 */}
      <span className="text-xs truncate flex-1">{tab.title}</span>

      {/* 未保存ドット */}
      {tab.isDirty && (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: "var(--accent, #007acc)" }}
          aria-label="未保存"
        />
      )}

      {/* 閉じるボタン */}
      <button
        className="w-4 h-4 flex items-center justify-center rounded text-xs opacity-0 group-hover:opacity-100 shrink-0 hover:bg-white/20"
        style={{ color: "var(--text-secondary, #858585)" }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="タブを閉じる"
      >
        ×
      </button>
    </div>
  );
}
