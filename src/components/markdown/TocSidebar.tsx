import type { TocItem } from "../../types";

interface TocSidebarProps {
  toc: TocItem[];
  activeAnchor: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function TocSidebar({ toc, activeAnchor, containerRef }: TocSidebarProps) {
  if (toc.length === 0) return null;

  function scrollTo(anchor: string) {
    const el = containerRef.current?.querySelector(`#${CSS.escape(anchor)}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav
      className="w-56 shrink-0 overflow-y-auto border-r py-4 text-sm"
      style={{
        borderColor: "var(--border-color)",
        backgroundColor: "var(--sidebar-bg)",
        color: "var(--text-secondary)",
      }}
    >
      <div className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide opacity-60">
        目次
      </div>
      <ul>
        {toc.map((item) => (
          <li key={item.anchor}>
            <button
              onClick={() => scrollTo(item.anchor)}
              style={{ paddingLeft: `${(item.level - 1) * 12 + 12}px` }}
              className={[
                "w-full text-left truncate py-1 pr-3 rounded transition-colors hover:opacity-100",
                activeAnchor === item.anchor ? "opacity-100 font-medium" : "opacity-60",
              ].join(" ")}
            >
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
