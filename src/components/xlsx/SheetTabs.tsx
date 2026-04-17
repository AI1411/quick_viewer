import type { XlsxSheetMeta } from "../../types";

interface SheetTabsProps {
  sheets: XlsxSheetMeta[];
  activeSheetName: string | null;
  onSheetSelect: (name: string) => void;
}

export function SheetTabs({ sheets, activeSheetName, onSheetSelect }: SheetTabsProps) {
  if (sheets.length === 0) return null;

  return (
    <div
      className="flex items-center overflow-x-auto flex-shrink-0 border-t"
      style={{
        height: 32,
        backgroundColor: "var(--tabbar-bg)",
        borderColor: "var(--border-color)",
      }}
    >
      {sheets.map((sheet) => {
        const isActive = sheet.name === activeSheetName;
        return (
          <button
            key={sheet.name}
            className="flex-shrink-0 px-4 text-xs border-r h-full"
            style={{
              borderColor: "var(--border-color)",
              color: isActive ? "var(--accent)" : "var(--text-secondary)",
              backgroundColor: isActive ? "var(--viewer-bg)" : "var(--tabbar-bg)",
              borderTop: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              fontWeight: isActive ? 600 : 400,
            }}
            onClick={() => onSheetSelect(sheet.name)}
            title={sheet.name}
          >
            {sheet.name}
          </button>
        );
      })}
    </div>
  );
}
