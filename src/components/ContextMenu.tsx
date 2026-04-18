import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 py-1 rounded shadow-lg text-xs"
      style={{
        left: x,
        top: y,
        backgroundColor: "var(--menu-bg, #2d2d2d)",
        border: "1px solid var(--border-color)",
        color: "var(--text-primary)",
        minWidth: "160px",
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div
            key={i}
            role="separator"
            className="my-1 border-t"
            style={{ borderColor: "var(--border-color)" }}
          />
        ) : (
          <button
            key={i}
            role="menuitem"
            tabIndex={0}
            className="w-full text-left px-3 py-1.5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={item.disabled}
            aria-disabled={item.disabled}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !item.disabled) {
                e.preventDefault();
                item.onClick();
                onClose();
              }
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
