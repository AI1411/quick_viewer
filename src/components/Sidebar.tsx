interface SidebarProps {
  isOpen: boolean;
}

export function Sidebar({ isOpen }: SidebarProps) {
  if (!isOpen) return null;

  return (
    <aside
      className="w-56 shrink-0 flex flex-col border-r overflow-hidden"
      style={{
        backgroundColor: "var(--sidebar-bg)",
        borderColor: "var(--border-color)",
      }}
    >
      <div
        className="px-3 py-2 text-xs font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-secondary)" }}
      >
        ファイル
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* Phase 2+ でファイルツリーを実装 */}
      </div>
    </aside>
  );
}
