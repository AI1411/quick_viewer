import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { EmptyState } from "./components/EmptyState";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ViewerArea } from "./components/ViewerArea";
import { SettingsDialog } from "./components/SettingsDialog";
import { RecentFilesMenu } from "./components/RecentFilesMenu";
import { openFile, showOpenDialog } from "./lib/fileCommands";
import { useTabStore, useSettingsStore, useSearchStore, useRecentFilesStore, showError } from "./stores";
import type { RecentFile } from "./stores";
import { Toast } from "./components/Toast";
import { errorMessage } from "./lib/errorUtils";
import { useShortcuts } from "./hooks/useShortcuts";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { FileChangedDialog } from "./components/FileChangedDialog";
import "./App.css";

interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  isMaximized: boolean;
}

async function handleOpenPath(
  path: string,
  addTab: ReturnType<typeof useTabStore.getState>["addTab"],
  setActiveTab: ReturnType<typeof useTabStore.getState>["setActiveTab"]
) {
  try {
    const info = await openFile(path);
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    addTab({ id, title: info.name, filePath: info.path, format: info.format, isDirty: false, reloadCount: 0 });
    setActiveTab(id);
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

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const [pendingReload, setPendingReload] = useState<{
    tabId: string;
    filePath: string;
  } | null>(null);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const bumpReload = useTabStore((s) => s.bumpReload);
  const theme = useSettingsStore((state) => state.theme);
  const zoomLevel = useSettingsStore((state) => state.zoomLevel);

  const handleFileChanged = useCallback(
    (tabId: string, filePath: string) => {
      setPendingReload((prev) => prev ?? { tabId, filePath });
    },
    []
  );

  useFileWatcher(handleFileChanged);

  // 起動時にディスクから設定と最近ファイルを読み込む
  useEffect(() => {
    useSettingsStore.getState().loadFromDisk();
    useRecentFilesStore.getState().loadFromDisk();
  }, []);

  // ウィンドウ状態の復元
  useEffect(() => {
    (async () => {
      try {
        const raw = await invoke<string | null>("load_app_data", { key: "window_state" });
        if (raw) {
          const state = JSON.parse(raw) as WindowState;
          const win = getCurrentWindow();
          if (state.isMaximized) {
            await win.maximize();
          } else {
            await win.setSize(new LogicalSize(state.width, state.height));
            await win.setPosition(new LogicalPosition(state.x, state.y));
          }
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
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const isMaximized = await win.isMaximized();
        await invoke("save_app_data", {
          key: "window_state",
          value: JSON.stringify({ width: size.width, height: size.height, x: pos.x, y: pos.y, isMaximized }),
        });
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
    win.onResized(debouncedSave).then((fn) => { unlisten1 = fn; });
    win.onMoved(debouncedSave).then((fn) => { unlisten2 = fn; });
    return () => {
      clearTimeout(saveTimer);
      unlisten1?.();
      unlisten2?.();
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

  // キーボードショートカット
  useShortcuts({
    // ファイル
    "cmd+o": () => {
      const { addTab, setActiveTab } = useTabStore.getState();
      showOpenDialog().then((path) => {
        if (path) handleOpenPath(path, addTab, setActiveTab);
      });
    },
    // 設定
    "cmd+,": () => setSettingsOpen((prev) => !prev),
    // タブ操作
    "cmd+w": () => {
      const { activeTabId: aid, removeTab } = useTabStore.getState();
      if (aid) removeTab(aid);
    },
    "cmd+tab": () => {
      const { tabs, activeTabId: aid, setActiveTab } = useTabStore.getState();
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === aid);
      const next = tabs[(idx + 1) % tabs.length];
      setActiveTab(next.id);
    },
    "cmd+shift+tab": () => {
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
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const paths = event.payload.paths ?? [];
          const { addTab, setActiveTab } = useTabStore.getState();
          for (const path of paths) {
            handleOpenPath(path, addTab, setActiveTab);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
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
          onReload={() => {
            bumpReload(pendingReload.tabId);
            setPendingReload(null);
          }}
          onDismiss={() => setPendingReload(null)}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
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
