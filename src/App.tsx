import { useEffect, useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ViewerArea } from "./components/ViewerArea";
import { useTabStore } from "./stores";
import "./App.css";

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeTabId = useTabStore((state) => state.activeTabId);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

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
