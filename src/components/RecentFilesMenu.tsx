import { useEffect, useRef } from "react";
import { useRecentFilesStore, type RecentFile } from "../stores/recentFilesStore";

interface Props {
  onOpen: (file: RecentFile) => void;
  onClose: () => void;
}

export function RecentFilesMenu({ onOpen, onClose }: Props) {
  const { recentFiles, clearRecentFiles } = useRecentFilesStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 rounded-lg shadow-xl overflow-hidden"
      style={{
        top: "40px",
        left: "16px",
        minWidth: "320px",
        maxWidth: "480px",
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="px-3 py-2 text-xs font-semibold flex items-center justify-between"
        style={{
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span>最近開いたファイル</span>
        {recentFiles.length > 0 && (
          <button
            onClick={() => { clearRecentFiles(); onClose(); }}
            className="text-xs hover:underline cursor-pointer"
            style={{ color: "var(--text-secondary)" }}
          >
            履歴をクリア
          </button>
        )}
      </div>

      {recentFiles.length === 0 ? (
        <div className="px-4 py-6 text-sm text-center" style={{ color: "var(--text-secondary)" }}>
          最近開いたファイルはありません
        </div>
      ) : (
        <ul className="max-h-80 overflow-y-auto py-1">
          {recentFiles.map((f) => (
            <li key={f.path}>
              <button
                className="w-full px-4 py-2 text-left text-sm flex items-center gap-2 cursor-pointer"
                style={{ color: "var(--text-primary)" }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "")}
                onClick={() => { onOpen(f); onClose(); }}
                title={f.path}
              >
                <span
                  className="shrink-0 text-xs px-1 rounded"
                  style={{ backgroundColor: "var(--bg-hover)", color: "var(--text-secondary)" }}
                >
                  {f.format.toUpperCase()}
                </span>
                <span className="truncate">{f.name}</span>
                <span
                  className="ml-auto text-xs truncate max-w-32 shrink-0"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {f.path.split("/").slice(-3, -1).join("/")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
