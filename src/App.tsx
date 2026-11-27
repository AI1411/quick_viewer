import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { EmptyState } from "./components/EmptyState";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ViewerArea } from "./components/ViewerArea";
import { SettingsDialog } from "./components/SettingsDialog";
import { RecentFilesMenu } from "./components/RecentFilesMenu";
import { openFile, showOpenDialog } from "./lib/fileCommands";
import { confirmCloseDirtyTabs, confirmUnsaved } from "./lib/confirmUnsaved";
import { reloadTabFromDisk } from "./lib/tabActions";
import { enqueueReload, nextReload, type PendingReload } from "./lib/reloadQueue";
import {
  useTabStore,
  useSettingsStore,
  useSearchStore,
  useRecentFilesStore,
  showError,
  showInfo,
} from "./stores";
import type { RecentFile } from "./stores";
import { Toast } from "./components/Toast";
import { errorMessage } from "./lib/errorUtils";
import { useShortcuts } from "./hooks/useShortcuts";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { FileChangedDialog } from "./components/FileChangedDialog";
import { BatchConvertDialog } from "./components/image/BatchConvertDialog";
import { useImageStore } from "./stores/imageStore";
import "./App.css";

async function handleOpenPath(
  path: string,
  addTab: ReturnType<typeof useTabStore.getState>["addTab"],
  setActiveTab: ReturnType<typeof useTabStore.getState>["setActiveTab"]
) {
  try {
    const info = await openFile(path);
    const existing = useTabStore
      .getState()
      .tabs.find((t) => t.filePath === info.path);
    if (existing) {
      setActiveTab(existing.id);
    } else {
      const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      addTab({
        id,
        title: info.name,
        filePath: info.path,
        format: info.format,
        isDirty: false,
        reloadCount: 0,
      });
      setActiveTab(id);
    }
    useRecentFilesStore.getState().addRecentFile({
      path: info.path,
      name: info.name,
      format: info.format as RecentFile["format"],
      openedAt: new Date().toISOString(),
    });
  } catch (err) {
    showError(`ファイルを開けませんでした: ${errorMessage(err)}`);
  }
}

async function openFileWithDialog() {
  try {
    const { addTab, setActiveTab } = useTabStore.getState();
    const path = await showOpenDialog();
    if (path) await handleOpenPath(path, addTab, setActiveTab);
  } catch (err) {
    showError(`ファイルダイアログを開けませんでした: ${errorMessage(err)}`);
  }
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const [reloadQueue, setReloadQueue] = useState<PendingReload[]>([]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const batchOpen = useImageStore((state) => state.batchPaths !== null);
  const openTabIds = useTabStore((state) => state.tabs.map((t) => t.id).join("\n"));
  const pendingReload = nextReload(reloadQueue, openTabIds.split("\n"));
  const finishReload = (tabId: string) => setReloadQueue((q) => q.filter((p) => p.tabId !== tabId));
  const theme = useSettingsStore((state) => state.theme);
  const zoomLevel = useSettingsStore((state) => state.zoomLevel);
  const fontFamily = useSettingsStore((state) => state.fontFamily);

  const handleFileChanged = useCallback(
    (tabId: string, filePath: string) => {
      setReloadQueue((q) => enqueueReload(q, { tabId, filePath }));
    },
    []
  );

  useFileWatcher(handleFileChanged);

  // 起動時にディスクから設定と最近ファイルを読み込む
  useEffect(() => {
    useSettingsStore.getState().loadFromDisk();
    useRecentFilesStore.getState().loadFromDisk();
  }, []);

  // 起動時に更新チェック
  useEffect(() => {
    check()
      .then((update) => {
        if (!update) return;
        showInfo(`新しいバージョン ${update.version} が利用可能です。`, {
          durationMs: 0,
          action: {
            label: "更新して再起動",
            onClick: async () => {
              try {
                await update.downloadAndInstall();
                await relaunch();
              } catch (err) {
                showError(`更新に失敗しました: ${errorMessage(err)}`);
              }
            },
          },
        });
      })
      .catch(() => {
        // 更新チェック失敗は無視（オフライン等）
      });
  }, []);

  // ウィンドウ状態の保存/復元は tauri-plugin-window-state が担当

  // Cmd+Q はウィンドウの close を経由しないため、Rust 側でメニューの「終了」を
  // quit-requested イベントに差し替えている。未保存の変更を確認してから閉じる
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("quit-requested", async () => {
      const dirtyTitles = useTabStore
        .getState()
        .tabs.filter((t) => t.isDirty)
        .map((t) => t.title);
      if (await confirmCloseDirtyTabs(dirtyTitles)) await getCurrentWindow().destroy();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // テーマを data-theme 属性に反映
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
  }, [theme]);

  // ズームレベルをフォントサイズに反映
  useEffect(() => {
    document.documentElement.style.fontSize = `${zoomLevel}px`;
  }, [zoomLevel]);

  // フォントファミリーをCSS変数に反映
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font-family", fontFamily);
  }, [fontFamily]);

  // キーボードショートカット
  useShortcuts({
    // ファイル
    "cmd+o": () => {
      void openFileWithDialog();
    },
    // 設定
    "cmd+,": () => setSettingsOpen((prev) => !prev),
    // タブ操作
    "cmd+w": async () => {
      const { activeTabId: aid, removeTab, tabs } = useTabStore.getState();
      if (!aid) return;
      const tab = tabs.find((t) => t.id === aid);
      if (tab?.isDirty) {
        const ok = await confirmUnsaved(tab.title);
        if (!ok) return;
      }
      removeTab(aid);
    },
    "ctrl+tab": () => {
      const { tabs, activeTabId: aid, setActiveTab } = useTabStore.getState();
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === aid);
      const next = tabs[(idx + 1) % tabs.length];
      setActiveTab(next.id);
    },
    "ctrl+shift+tab": () => {
      const { tabs, activeTabId: aid, setActiveTab } = useTabStore.getState();
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === aid);
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      setActiveTab(prev.id);
    },
    // タブ番号切り替え (Cmd+1〜9)
    "cmd+1": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[0]) setActiveTab(tabs[0].id); },
    "cmd+2": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[1]) setActiveTab(tabs[1].id); },
    "cmd+3": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[2]) setActiveTab(tabs[2].id); },
    "cmd+4": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[3]) setActiveTab(tabs[3].id); },
    "cmd+5": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[4]) setActiveTab(tabs[4].id); },
    "cmd+6": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[5]) setActiveTab(tabs[5].id); },
    "cmd+7": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[6]) setActiveTab(tabs[6].id); },
    "cmd+8": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[7]) setActiveTab(tabs[7].id); },
    "cmd+9": () => { const { tabs, setActiveTab } = useTabStore.getState(); if (tabs[8]) setActiveTab(tabs[8].id); },
    // UI
    "cmd+b": () => setSidebarOpen((prev) => !prev),
    // ズーム
    "cmd++": () => useSettingsStore.getState().increaseZoom(),
    "cmd+=": () => useSettingsStore.getState().increaseZoom(),
    "cmd+-": () => useSettingsStore.getState().decreaseZoom(),
    "cmd+0": () => useSettingsStore.getState().resetZoom(),
    "cmd+f": () => {
      const { isOpen, setOpen } = useSearchStore.getState();
      setOpen(!isOpen);
    },
    "cmd+g": () => {
      const { isOpen, nextMatch } = useSearchStore.getState();
      if (isOpen) nextMatch();
    },
    "cmd+shift+g": () => {
      const { isOpen, prevMatch } = useSearchStore.getState();
      if (isOpen) prevMatch();
    },
  });

  useEffect(() => {
    const store = useSearchStore.getState();
    store.setCellMatches([]);
    store.setPdfMatches([]);
    store.setMatchCount(0);
  }, [activeTabId]);

  useEffect(() => {
    // ドラッグ&ドロップ
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        if (event.payload.type === "drop") {
          const paths = event.payload.paths ?? [];
          const { addTab, setActiveTab } = useTabStore.getState();
          for (const path of paths) {
            handleOpenPath(path, addTab, setActiveTab);
          }
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
  }, []);

  // Finder / `open -a` 経由のファイルオープン（起動時バッファ＋実行中イベント）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const openPaths = (paths: string[]) => {
      const { addTab, setActiveTab } = useTabStore.getState();
      for (const path of paths) {
        void handleOpenPath(path, addTab, setActiveTab);
      }
    };

    (async () => {
      try {
        const un = await listen<string[]>("open-paths", (event) => {
          if (cancelled) return;
          openPaths(event.payload ?? []);
        });
        if (cancelled) {
          un();
          return;
        }
        unlisten = un;
        // リスナー登録後に ready を通知し、コールドスタート分をフラッシュ
        await invoke("frontend_ready");
      } catch (err) {
        console.error("Failed to wire file-open associations:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div
      className="flex flex-col h-full"
      style={{ color: "var(--text-primary)" }}
    >
      <TitleBar onRecentClick={() => setRecentMenuOpen((prev) => !prev)} />
      <TabBar onNewTab={() => { void openFileWithDialog(); }} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={sidebarOpen} />
        <main className="flex-1 flex overflow-hidden">
          {activeTabId ? (
            <ViewerArea />
          ) : (
            <EmptyState
              onOpenFile={async (path) => {
                const { addTab, setActiveTab } = useTabStore.getState();
                await handleOpenPath(path, addTab, setActiveTab);
              }}
            />
          )}
        </main>
      </div>
      {pendingReload && (
        <FileChangedDialog
          filePath={pendingReload.filePath}
          hasUnsavedChanges={
            useTabStore.getState().tabs.find((t) => t.id === pendingReload.tabId)?.isDirty ?? false
          }
          onReload={() => {
            reloadTabFromDisk(pendingReload.tabId);
            finishReload(pendingReload.tabId);
          }}
          onDismiss={() => finishReload(pendingReload.tabId)}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {batchOpen && <BatchConvertDialog />}
      {recentMenuOpen && (
        <RecentFilesMenu
          onOpen={async (file) => {
            const { addTab, setActiveTab } = useTabStore.getState();
            await handleOpenPath(file.path, addTab, setActiveTab);
          }}
          onClose={() => setRecentMenuOpen(false)}
        />
      )}
      <Toast />
    </div>
  );
}

export default App;
