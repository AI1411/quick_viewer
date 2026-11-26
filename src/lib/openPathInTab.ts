import { openFile } from "./fileCommands";
import { errorMessage } from "./errorUtils";
import { useTabStore } from "../stores/tabStore";
import { useRecentFilesStore, type RecentFile } from "../stores/recentFilesStore";
import { showError } from "../stores/toastStore";

/**
 * ファイルをタブで開く。既に開いていればそのタブに切り替える。
 * 同じファイルを 2 つのタブで開くと、片方の保存がもう片方に通知されず
 * (自分の保存として無視される)、古い内容のまま上書き保存してしまうため。
 */
export async function openPathInTab(path: string): Promise<void> {
  try {
    const info = await openFile(path);
    const { tabs, addTab, setActiveTab } = useTabStore.getState();
    const existing = tabs.find((t) => t.filePath === info.path);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
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
