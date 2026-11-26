import { useCallback, useState } from "react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Tab } from "./Tab";
import { useTabStore } from "../stores";
import { closeTab, closeOtherTabs, closeTabsToRight } from "../lib/tabActions";

interface ContextMenuState {
  x: number;
  y: number;
  tabId: string;
}

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, reorderTabs } = useTabStore();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    e.dataTransfer.setData("text/plain", tabId);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/plain");
      if (dragId) {
        reorderTabs(dragId, toIndex);
      }
      setDragOverIndex(null);
    },
    [reorderTabs]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, tabId });
    },
    []
  );

  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? buildContextMenuItems(contextMenu.tabId, tabs)
    : [];

  return (
    <div
      className="h-9 shrink-0 flex items-stretch overflow-x-auto border-b"
      style={{
        backgroundColor: "var(--tabbar-bg)",
        borderColor: "var(--border-color)",
      }}
      onDragLeave={() => setDragOverIndex(null)}
    >
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          className="flex items-stretch"
          style={{
            opacity: dragOverIndex === index ? 0.5 : 1,
          }}
        >
          <Tab
            tab={tab}
            isActive={tab.id === activeTabId}
            index={index}
            onActivate={() => setActiveTab(tab.id)}
            onClose={() => void closeTab(tab.id)}
            onContextMenu={handleContextMenu}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          />
        </div>
      ))}

      {/* 新規タブボタン（Phase 1.4 でファイルオープンダイアログと連携） */}
      <button
        className="px-2 flex items-center opacity-50 hover:opacity-100 text-lg leading-none"
        style={{ color: "var(--text-secondary, #858585)" }}
        aria-label="新しいタブ"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverIndex(tabs.length);
        }}
        onDrop={(e) => handleDrop(e, tabs.length)}
      >
        +
      </button>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function buildContextMenuItems(
  tabId: string,
  tabs: Array<{ id: string }>
): ContextMenuItem[] {
  const tabIndex = tabs.findIndex((t) => t.id === tabId);
  const hasOthers = tabs.length > 1;
  const hasRight = tabIndex < tabs.length - 1;

  return [
    { label: "閉じる", onClick: () => void closeTab(tabId) },
    { separator: true, label: "", onClick: () => {} },
    {
      label: "他を全て閉じる",
      onClick: () => void closeOtherTabs(tabId),
      disabled: !hasOthers,
    },
    {
      label: "右側を全て閉じる",
      onClick: () => void closeTabsToRight(tabId),
      disabled: !hasRight,
    },
  ];
}
