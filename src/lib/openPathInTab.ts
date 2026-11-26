import { openFile } from "./fileCommands";
import { errorMessage } from "./errorUtils";
import { useTabStore } from "../stores/tabStore";
import { useRecentFilesStore, type RecentFile } from "../stores/recentFilesStore";
import { showError } from "../stores/toastStore";

export async function openPathInTab(path: string): Promise<void> {
  try {
    const info = await openFile(path);
    const { addTab, setActiveTab } = useTabStore.getState();
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
