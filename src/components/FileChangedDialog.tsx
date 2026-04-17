interface Props {
  filePath: string;
  onReload: () => void;
  onDismiss: () => void;
}

export function FileChangedDialog({ filePath, onReload, onDismiss }: Props) {
  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
    >
      <div
        className="rounded-lg p-6 shadow-xl max-w-sm w-full mx-4"
        style={{
          backgroundColor: "var(--bg-secondary)",
          color: "var(--text-primary)",
          border: "1px solid var(--border)",
        }}
      >
        <h2 className="text-base font-semibold mb-2">ファイルが変更されました</h2>
        <p className="text-sm mb-6" style={{ color: "var(--text-secondary)" }}>
          <span
            className="font-mono"
            style={{
              backgroundColor: "var(--bg-hover)",
              padding: "1px 4px",
              borderRadius: "3px",
            }}
          >
            {fileName}
          </span>{" "}
          が外部で変更されました。再読み込みしますか？
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onDismiss}
            className="px-4 py-1.5 text-sm rounded cursor-pointer"
            style={{
              backgroundColor: "var(--bg-hover)",
              color: "var(--text-primary)",
            }}
          >
            無視
          </button>
          <button
            onClick={onReload}
            className="px-4 py-1.5 text-sm rounded font-medium cursor-pointer"
            style={{ backgroundColor: "var(--accent)", color: "white" }}
          >
            再読み込み
          </button>
        </div>
      </div>
    </div>
  );
}
