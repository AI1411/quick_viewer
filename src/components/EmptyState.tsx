import { useRecentFilesStore } from "../stores/recentFilesStore";

interface Props {
  onOpenFile?: (path: string) => void;
}

export function EmptyState({ onOpenFile }: Props) {
  const recentFiles = useRecentFilesStore((s) => s.recentFiles);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6">
      <div className="flex flex-col items-center gap-2">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: "var(--text-secondary)", opacity: 0.4 }}
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <p
          className="text-base font-medium"
          style={{ color: "var(--text-secondary)" }}
        >
          ファイルを開いてください
        </p>
      </div>
      <div
        className="flex flex-col items-center gap-1.5 text-sm"
        style={{ color: "var(--text-secondary)", opacity: 0.6 }}
      >
        <p>
          <kbd
            className="px-1.5 py-0.5 rounded text-xs border"
            style={{ borderColor: "var(--border-color)" }}
          >
            ⌘O
          </kbd>{" "}
          でファイルを選択
        </p>
        <p>または ドラッグ&ドロップ でファイルを追加</p>
      </div>

      {recentFiles.length > 0 && onOpenFile && (
        <div className="mt-2 w-72">
          <p className="text-xs font-semibold mb-2 text-center" style={{ color: "var(--text-secondary)" }}>
            最近開いたファイル
          </p>
          <ul className="space-y-1">
            {recentFiles.slice(0, 5).map((f) => (
              <li key={f.path}>
                <button
                  className="w-full px-3 py-1.5 text-left text-sm rounded flex items-center gap-2 cursor-pointer"
                  style={{ color: "var(--text-primary)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "")}
                  onClick={() => onOpenFile(f.path)}
                  title={f.path}
                >
                  <span
                    className="shrink-0 text-xs px-1 rounded"
                    style={{ backgroundColor: "var(--bg-hover)", color: "var(--text-secondary)" }}
                  >
                    {f.format.toUpperCase()}
                  </span>
                  <span className="truncate">{f.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
