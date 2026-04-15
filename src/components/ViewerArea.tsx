import { useTabStore } from "../stores/tabStore";
import { CsvViewer } from "./csv/CsvViewer";
import { PdfViewer } from "./pdf/PdfViewer";

export function ViewerArea() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) return null;

  if (activeTab.format === "csv" || activeTab.format === "tsv") {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <CsvViewer tabId={activeTab.id} filePath={activeTab.filePath} />
      </div>
    );
  }

  if (activeTab.format === "pdf") {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <PdfViewer tabId={activeTab.id} filePath={activeTab.filePath} />
      </div>
    );
  }

  // 他の形式は今後実装予定
  return (
    <div
      className="flex-1 flex items-center justify-center text-sm"
      style={{
        color: "var(--text-secondary)",
        backgroundColor: "var(--viewer-bg)",
      }}
    >
      {activeTab.format} ビューアは実装予定
    </div>
  );
}
