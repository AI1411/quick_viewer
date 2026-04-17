use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct WatcherState(pub Mutex<HashMap<String, RecommendedWatcher>>);

#[tauri::command]
pub fn watch_file(
    path: String,
    state: tauri::State<WatcherState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut watchers = state.0.lock().unwrap();
    if watchers.contains_key(&path) {
        return Ok(());
    }
    let path_clone = path.clone();
    let app_clone = app.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Modify(_) | EventKind::Create(_) => {
                        let _ = app_clone.emit("file-changed", path_clone.clone());
                    }
                    _ => {}
                }
            }
        })
        .map_err(|e| e.to_string())?;
    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    watchers.insert(path, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(path: String, state: tauri::State<WatcherState>) -> Result<(), String> {
    let mut watchers = state.0.lock().unwrap();
    watchers.remove(&path);
    Ok(())
}
