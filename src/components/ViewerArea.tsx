import { useTabStore } from "../stores/tabStore";
import { CsvViewer } from "./csv/CsvViewer";
import { PdfViewer } from "./pdf/PdfViewer";
import { MarkdownViewer } from "./markdown/MarkdownViewer";
import { XlsxViewer } from "./xlsx/XlsxViewer";
import { ImageViewer } from "./image/ImageViewer";
import { SearchBar } from "./SearchBar";

export function ViewerArea() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) return null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <SearchBar />
      {activeTab.format === "csv" || activeTab.format === "tsv" ? (
        <CsvViewer key={`${activeTab.id}-${activeTab.reloadCount}`} tabId={activeTab.id} filePath={activeTab.filePath} />
      ) : activeTab.format === "pdf" ? (
        <PdfViewer key={`${activeTab.id}-${activeTab.reloadCount}`} tabId={activeTab.id} filePath={activeTab.filePath} />
      ) : activeTab.format === "markdown" ? (
        <MarkdownViewer key={`${activeTab.id}-${activeTab.reloadCount}`} tabId={activeTab.id} filePath={activeTab.filePath} />
      ) : activeTab.format === "xlsx" ? (
        <XlsxViewer key={`${activeTab.id}-${activeTab.reloadCount}`} tabId={activeTab.id} filePath={activeTab.filePath} />
      ) : activeTab.format === "image" ? (
        <ImageViewer key={`${activeTab.id}-${activeTab.reloadCount}`} tabId={activeTab.id} filePath={activeTab.filePath} />
      ) : (
        <div
          className="flex-1 flex items-center justify-center text-sm"
          style={{
            color: "var(--text-secondary)",
            backgroundColor: "var(--viewer-bg)",
          }}
        >
          {activeTab.format} ビューアは実装予定
        </div>
      )}
    </div>
  );
}
