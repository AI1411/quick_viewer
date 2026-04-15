import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { EmptyState } from "./components/EmptyState";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ViewerArea } from "./components/ViewerArea";
import { openFile, showOpenDialog } from "./lib/fileCommands";
import { useTabStore, useSettingsStore } from "./stores";
import "./App.css";

async function handleOpenPath(
  path: string,
  addTab: ReturnType<typeof useTabStore.getState>["addTab"],
  setActiveTab: ReturnType<typeof useTabStore.getState>["setActiveTab"]
) {
  try {
    const info = await openFile(path);
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    addTab({ id, title: info.name, filePath: info.path, isDirty: false });
    setActiveTab(id);
  } catch (err) {
    console.error("Failed to open file:", err);
  }
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const theme = useSettingsStore((state) => state.theme);
  const zoomLevel = useSettingsStore((state) => state.zoomLevel);

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

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Cmd+O: ファイルオープンダイアログ
      if (e.key === "o") {
        e.preventDefault();
        const { addTab, setActiveTab } = useTabStore.getState();
        showOpenDialog().then((path) => {
          if (path) handleOpenPath(path, addTab, setActiveTab);
        });
        return;
      }

      // Cmd+B: サイドバートグル
      if (e.key === "b") {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
        return;
      }

      // Cmd+W: アクティブタブを閉じる
      if (e.key === "w") {
        e.preventDefault();
        const { activeTabId: aid, removeTab } = useTabStore.getState();
        if (aid) removeTab(aid);
        return;
      }

      // Cmd++ / Cmd+= : ズームイン
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        useSettingsStore.getState().increaseZoom();
        return;
      }

      // Cmd+- : ズームアウト
      if (e.key === "-") {
        e.preventDefault();
        useSettingsStore.getState().decreaseZoom();
        return;
      }

      // Cmd+0 : ズームリセット
      if (e.key === "0") {
        e.preventDefault();
        useSettingsStore.getState().resetZoom();
        return;
      }

      // Cmd+1~9: タブ切り替え
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9) {
        e.preventDefault();
        const { tabs, setActiveTab } = useTabStore.getState();
        const target = tabs[num - 1];
        if (target) setActiveTab(target.id);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
      <TitleBar />
      <TabBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={sidebarOpen} />
        <main className="flex-1 flex overflow-hidden">
          {activeTabId ? <ViewerArea /> : <EmptyState />}
        </main>
      </div>
    </div>
  );
}

export default App;
