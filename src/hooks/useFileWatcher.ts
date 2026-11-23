import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "../stores/tabStore";
import { isSelfWrite } from "../lib/selfWriteGuard";

export function useFileWatcher(
  onFileChanged: (tabId: string, filePath: string) => void
) {
  const tabs = useTabStore((s) => s.tabs);
  const watchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const current = new Set(tabs.map((t) => t.filePath));

    for (const path of current) {
      if (!watchedRef.current.has(path)) {
        invoke("watch_file", { path }).catch(console.error);
        watchedRef.current.add(path);
      }
    }

    for (const path of watchedRef.current) {
      if (!current.has(path)) {
        invoke("unwatch_file", { path }).catch(console.error);
        watchedRef.current.delete(path);
      }
    }
  }, [tabs]);

  useEffect(() => {
    const watched = watchedRef.current;
    return () => {
      for (const path of watched) {
        invoke("unwatch_file", { path }).catch(console.error);
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>("file-changed", (event) => {
      if (cancelled) return;
      const changedPath = event.payload;
      if (isSelfWrite(changedPath)) return; // 自分の保存を無視
      const matchingTabs = useTabStore
        .getState()
        .tabs.filter((t) => t.filePath === changedPath);
      for (const tab of matchingTabs) {
        onFileChanged(tab.id, changedPath);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onFileChanged]);
}
