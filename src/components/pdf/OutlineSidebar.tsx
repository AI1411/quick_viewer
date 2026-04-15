import type { OutlineItem } from "../../types";

interface OutlineNodeProps {
  item: OutlineItem;
  currentPage: number; // 1-based
  onPageSelect: (page: number) => void;
}

function OutlineNode({ item, currentPage, onPageSelect }: OutlineNodeProps) {
  // item.page は 0-based。1-based に変換して比較・ジャンプ
  const targetPage = item.page !== null ? item.page + 1 : null;
  const isActive = targetPage !== null && targetPage === currentPage;

  return (
    <div>
      <button
        onClick={() => {
          if (targetPage !== null) onPageSelect(targetPage);
        }}
        title={targetPage !== null ? `ページ ${targetPage}` : item.title}
        className="w-full text-left rounded px-2 py-0.5 text-xs hover:bg-white/10 truncate"
        style={{
          paddingLeft: `${8 + item.level * 12}px`,
          color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
          fontWeight: isActive ? 600 : 400,
          backgroundColor: isActive ? "var(--tab-active-bg)" : "transparent",
          cursor: targetPage !== null ? "pointer" : "default",
          border: "none",
          display: "block",
        }}
      >
        {item.title}
      </button>
      {item.children.map((child, i) => (
        <OutlineNode
          key={i}
          item={child}
          currentPage={currentPage}
          onPageSelect={onPageSelect}
        />
      ))}
    </div>
  );
}

interface OutlineSidebarProps {
  outlines: OutlineItem[];
  currentPage: number; // 1-based
  onPageSelect: (page: number) => void;
}

export function OutlineSidebar({
  outlines,
  currentPage,
  onPageSelect,
}: OutlineSidebarProps) {
  return (
    <div
      className="flex flex-col overflow-hidden flex-shrink-0"
      style={{
        width: 200,
        borderRight: "1px solid var(--border-color)",
        backgroundColor: "var(--sidebar-bg, var(--tabbar-bg))",
      }}
    >
      <div
        className="text-xs font-medium px-2 py-1 flex-shrink-0"
        style={{
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        目次
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {outlines.length === 0 ? (
          <p
            className="text-xs px-2 py-2"
            style={{ color: "var(--text-secondary)" }}
          >
            目次なし
          </p>
        ) : (
          outlines.map((item, i) => (
            <OutlineNode
              key={i}
              item={item}
              currentPage={currentPage}
              onPageSelect={onPageSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
