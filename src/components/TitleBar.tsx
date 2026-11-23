import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirmCloseDirtyTabs } from "../lib/confirmUnsaved";
import { useTabStore } from "../stores";

interface Props {
  onRecentClick?: () => void;
}

export function TitleBar({ onRecentClick }: Props) {
  const appWindow = getCurrentWindow();
  const allowCloseRef = useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    appWindow
      .onCloseRequested(async (event) => {
        if (allowCloseRef.current) return;

        const dirtyTitles = useTabStore
          .getState()
          .tabs.filter((t) => t.isDirty)
          .map((t) => t.title);

        if (dirtyTitles.length === 0) return;

        event.preventDefault();
        const ok = await confirmCloseDirtyTabs(dirtyTitles);
        if (ok) {
          allowCloseRef.current = true;
          await appWindow.close();
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appWindow]);

  return (
    <div
      data-tauri-drag-region
      className="flex items-center h-9 px-3 select-none shrink-0 relative"
      style={{ backgroundColor: "var(--titlebar-bg)" }}
    >
      {/* macOS トラフィックライト */}
      <div className="flex items-center gap-2 z-10">
        <button
          title="閉じる"
          onClick={() => appWindow.close()}
          className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-90 transition-[filter]"
          aria-label="閉じる"
        />
        <button
          title="最小化"
          onClick={() => appWindow.minimize()}
          className="w-3 h-3 rounded-full bg-[#febc2e] hover:brightness-90 transition-[filter]"
          aria-label="最小化"
        />
        <button
          title="最大化"
          onClick={() => appWindow.toggleMaximize()}
          className="w-3 h-3 rounded-full bg-[#28c840] hover:brightness-90 transition-[filter]"
          aria-label="最大化"
        />
      </div>

      {/* 最近開いたファイルボタン */}
      {onRecentClick && (
        <button
          title="最近開いたファイル"
          onClick={onRecentClick}
          className="ml-4 px-2 py-0.5 text-xs rounded cursor-pointer z-10"
          style={{
            color: "var(--text-secondary)",
            backgroundColor: "transparent",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          最近
        </button>
      )}

      {/* タイトル（中央配置） */}
      <span
        data-tauri-drag-region
        className="absolute left-1/2 -translate-x-1/2 text-xs font-medium pointer-events-none"
        style={{ color: "var(--text-secondary)" }}
      >
        QuickView
      </span>
    </div>
  );
}
