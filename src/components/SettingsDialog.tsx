import { useState, useEffect, useRef } from "react";
import { useSettingsStore, type Theme, type CsvSettings, type PdfSettings, type MarkdownSettings } from "../stores/settingsStore";

type TabId = "general" | "csv" | "pdf" | "markdown";

interface Props {
  onClose: () => void;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "一般" },
  { id: "csv", label: "CSV/TSV" },
  { id: "pdf", label: "PDF" },
  { id: "markdown", label: "Markdown" },
];

const selectStyle: React.CSSProperties = {
  backgroundColor: "var(--bg-primary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  padding: "4px 8px",
  fontSize: "13px",
  cursor: "pointer",
};

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <label className="text-sm" style={{ color: "var(--text-primary)" }}>{label}</label>
      {children}
    </div>
  );
}

export function SettingsDialog({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const {
    theme, setTheme,
    fontFamily, setFontFamily,
    csvSettings, setCsvSettings,
    pdfSettings, setPdfSettings,
    markdownSettings, setMarkdownSettings,
  } = useSettingsStore();

  // フォーカス初期化
  useEffect(() => {
    if (dialogRef.current) {
      const firstFocusable = dialogRef.current.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    }
  }, []);

  // Esc キーで閉じる
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const tabStyle = (id: TabId): React.CSSProperties => ({
    padding: "6px 14px",
    fontSize: "13px",
    cursor: "pointer",
    borderRadius: "4px",
    width: "100%",
    textAlign: "left",
    backgroundColor: activeTab === id ? "var(--bg-hover)" : "transparent",
    color: activeTab === id ? "var(--text-primary)" : "var(--text-secondary)",
    border: "none",
    fontWeight: activeTab === id ? 600 : 400,
  });

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="設定"
        className="rounded-xl shadow-2xl flex overflow-hidden"
        style={{
          width: "560px",
          maxHeight: "80vh",
          backgroundColor: "var(--bg-secondary)",
          color: "var(--text-primary)",
          border: "1px solid var(--border)",
        }}
      >
        {/* サイドバータブ */}
        <div
          className="flex flex-col py-4 px-2 gap-1"
          style={{ width: "120px", borderRight: "1px solid var(--border)", backgroundColor: "var(--bg-primary)" }}
        >
          <div className="px-2 pb-2 text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
            設定
          </div>
          {TABS.map((t) => (
            <button key={t.id} style={tabStyle(t.id)} onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* コンテンツ */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* ヘッダ */}
          <div
            className="flex items-center justify-between px-6 py-4"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <h2 className="text-base font-semibold">
              {TABS.find((t) => t.id === activeTab)?.label}設定
            </h2>
            <button
              onClick={onClose}
              className="rounded-full w-6 h-6 flex items-center justify-center text-sm cursor-pointer"
              style={{ backgroundColor: "var(--bg-hover)", color: "var(--text-secondary)" }}
            >
              ✕
            </button>
          </div>

          {/* タブコンテンツ */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {activeTab === "general" && (
              <>
                <SettingRow label="テーマ">
                  <select
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as Theme)}
                    style={selectStyle}
                  >
                    <option value="system">システム</option>
                    <option value="light">ライト</option>
                    <option value="dark">ダーク</option>
                  </select>
                </SettingRow>
                <SettingRow label="フォント">
                  <select
                    value={fontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                    style={selectStyle}
                  >
                    <option value="system-ui">システムフォント</option>
                    <option value="monospace">等幅フォント</option>
                    <option value="'Helvetica Neue', Arial, sans-serif">Helvetica Neue</option>
                    <option value="Georgia, serif">Georgia</option>
                  </select>
                </SettingRow>
              </>
            )}

            {activeTab === "csv" && (
              <SettingRow label="デフォルト区切り文字">
                <select
                  value={csvSettings.defaultDelimiter}
                  onChange={(e) => setCsvSettings({ defaultDelimiter: e.target.value as CsvSettings["defaultDelimiter"] })}
                  style={selectStyle}
                >
                  <option value="auto">自動検出</option>
                  <option value=",">カンマ (,)</option>
                  <option value={"\t"}>タブ</option>
                  <option value=";">セミコロン (;)</option>
                  <option value="|">パイプ (|)</option>
                </select>
              </SettingRow>
            )}

            {activeTab === "pdf" && (
              <SettingRow label="デフォルト表示モード">
                <select
                  value={pdfSettings.defaultViewMode}
                  onChange={(e) => setPdfSettings({ defaultViewMode: e.target.value as PdfSettings["defaultViewMode"] })}
                  style={selectStyle}
                >
                  <option value="single">1 ページ</option>
                  <option value="continuous">連続スクロール</option>
                </select>
              </SettingRow>
            )}

            {activeTab === "markdown" && (
              <SettingRow label="デフォルト表示">
                <select
                  value={markdownSettings.defaultView}
                  onChange={(e) => setMarkdownSettings({ defaultView: e.target.value as MarkdownSettings["defaultView"] })}
                  style={selectStyle}
                >
                  <option value="preview">プレビュー</option>
                  <option value="source">ソース</option>
                  <option value="split">分割</option>
                </select>
              </SettingRow>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
