import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { EmptyState } from "./components/EmptyState";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ViewerArea } from "./components/ViewerArea";
import { SettingsDialog } from "./components/SettingsDialog";
import { RecentFilesMenu } from "./components/RecentFilesMenu";
import { showOpenDialog } from "./lib/fileCommands";
import { openPathInTab } from "./lib/openPathInTab";
import { reloadTabFromDisk, closeTab, confirmCloseAllTabs } from "./lib/tabActions";
import { enqueueReload, nextReload, type PendingReload } from "./lib/reloadQueue";
import { parseSavedWindowState, toRestoreBounds, type SavedWindowState } from "./lib/windowState";
import { useTabStore, useSettingsStore, useSearchStore, useRecentFilesStore, showError } from "./stores";
import { Toast } from "./components/Toast";
import { errorMessage } from "./lib/errorUtils";
import { useShortcuts } from "./hooks/useShortcuts";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { FileChangedDialog } from "./components/FileChangedDialog";
import "./App.css";

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const [reloadQueue, setReloadQueue] = useState<PendingReload[]>([]);
  const activeTabId = useTabStore((state) => state.activeTabId);
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
        if (update?.available) {
          showError(`新しいバージョン ${update.version} が利用可能です。`);
        }
      })
      .catch(() => {
        // 更新チェック失敗は無視（オフライン等）
      });
  }, []);

  // ウィンドウ状態の復元
  useEffect(() => {
    (async () => {
      try {
        const raw = await invoke<string | null>("load_app_data", { key: "window_state" });
        const saved = raw ? parseSavedWindowState(raw) : null;
        if (!saved) return;
        const win = getCurrentWindow();
        if (saved.isMaximized) {
          await win.maximize();
          return;
        }
        const monitors = await availableMonitors().catch(() => []);
        const bounds = toRestoreBounds(
          saved,
          await win.scaleFactor(),
          monitors.map((m) => ({
            ...m.position.toLogical(m.scaleFactor),
            ...m.size.toLogical(m.scaleFactor),
          }))
        );
        await win.setSize(new LogicalSize(bounds.width, bounds.height));
        if (bounds.position) {
          await win.setPosition(new LogicalPosition(bounds.position.x, bounds.position.y));
        }
      } catch {
        // 初回起動 or エラー時はデフォルト
      }
    })();
  }, []);

  // ウィンドウ状態の保存（リサイズ / 移動）
  useEffect(() => {
    const win = getCurrentWindow();
    let saveTimer: ReturnType<typeof setTimeout>;
    const save = async () => {
      try {
        const factor = await win.scaleFactor();
        const size = (await win.innerSize()).toLogical(factor);
        const pos = (await win.outerPosition()).toLogical(factor);
        const isMaximized = await win.isMaximized();
        const state: SavedWindowState = {
          width: size.width,
          height: size.height,
          x: pos.x,
          y: pos.y,
          isMaximized,
          unit: "logical",
        };
        await invoke("save_app_data", { key: "window_state", value: JSON.stringify(state) });
      } catch {
        // サイレント
      }
    };
    const debouncedSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 500);
    };
    let unlisten1: (() => void) | undefined;
    let unlisten2: (() => void) | undefined;
    let cancelled = false;
    win.onResized(debouncedSave).then((fn) => {
      if (cancelled) fn();
      else unlisten1 = fn;
    });
    win.onMoved(debouncedSave).then((fn) => {
      if (cancelled) fn();
      else unlisten2 = fn;
    });
    return () => {
      cancelled = true;
      clearTimeout(saveTimer);
      unlisten1?.();
      unlisten2?.();
    };
  }, []);

  // ウィンドウを閉じる・アプリを終了する前に未保存の変更を確認する
  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const track = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    track(
      win.onCloseRequested(async (event) => {
        if (!(await confirmCloseAllTabs())) event.preventDefault();
      })
    );
    // Cmd+Q はウィンドウの close を経由しないため、Rust 側でメニューの「終了」をこのイベントに差し替えている
    track(
      listen("quit-requested", async () => {
        if (await confirmCloseAllTabs()) await win.destroy();
      })
    );
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
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
    "cmd+o": async () => {
      try {
        const path = await showOpenDialog();
        if (path) await openPathInTab(path);
      } catch (err) {
        showError(`ファイルダイアログを開けませんでした: ${errorMessage(err)}`);
      }
    },
    // 設定
    "cmd+,": () => setSettingsOpen((prev) => !prev),
    // タブ操作
    "cmd+w": () => {
      const { activeTabId: aid } = useTabStore.getState();
      if (aid) void closeTab(aid);
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
          for (const path of paths) {
            openPathInTab(path);
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

  return (
    <div
      className="flex flex-col h-full"
      style={{ color: "var(--text-primary)" }}
    >
      <TitleBar onRecentClick={() => setRecentMenuOpen((prev) => !prev)} />
      <TabBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={sidebarOpen} />
        <main className="flex-1 flex overflow-hidden">
          {activeTabId ? (
            <ViewerArea />
          ) : (
            <EmptyState
              onOpenFile={openPathInTab}
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
      {recentMenuOpen && (
        <RecentFilesMenu
          onOpen={(file) => openPathInTab(file.path)}
          onClose={() => setRecentMenuOpen(false)}
        />
      )}
      <Toast />
    </div>
  );
}

export default App;
