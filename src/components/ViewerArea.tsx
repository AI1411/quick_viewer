import { useTabStore } from "../stores/tabStore";
import { CsvViewer } from "./csv/CsvViewer";
import { PdfViewer } from "./pdf/PdfViewer";
import { MarkdownViewer } from "./markdown/MarkdownViewer";
import { XlsxViewer } from "./xlsx/XlsxViewer";
import { SearchBar } from "./SearchBar";
import type { Tab } from "../stores/tabStore";

function renderViewer(tab: Tab, isActive: boolean) {
  const common = {
    tabId: tab.id,
    filePath: tab.filePath,
    isActive,
  };

  if (tab.format === "csv" || tab.format === "tsv") {
    return <CsvViewer key={`${tab.id}-${tab.reloadCount}`} {...common} />;
  }
  if (tab.format === "pdf") {
    return <PdfViewer key={`${tab.id}-${tab.reloadCount}`} {...common} />;
  }
  if (tab.format === "markdown") {
    return <MarkdownViewer key={`${tab.id}-${tab.reloadCount}`} {...common} />;
  }
  if (tab.format === "xlsx") {
    return <XlsxViewer key={`${tab.id}-${tab.reloadCount}`} {...common} />;
  }
  return (
    <div
      className="flex-1 flex items-center justify-center text-sm"
      style={{
        color: "var(--text-secondary)",
        backgroundColor: "var(--viewer-bg)",
      }}
    >
      {tab.format} ビューアは実装予定
    </div>
  );
}

export function ViewerArea() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);

  if (tabs.length === 0) return null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <SearchBar />
      <div className="flex-1 relative overflow-hidden">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className="absolute inset-0 flex flex-col overflow-hidden"
              style={{
                visibility: isActive ? "visible" : "hidden",
                pointerEvents: isActive ? "auto" : "none",
                zIndex: isActive ? 1 : 0,
              }}
              aria-hidden={!isActive}
            >
              {renderViewer(tab, isActive)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
