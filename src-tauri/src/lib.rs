pub mod csv_commands;
pub mod file_watcher_commands;
pub mod markdown_commands;
pub mod pdf_commands;
pub mod persistence_commands;
pub mod utils;
pub mod xlsx_commands;

use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Paths from Finder / `open -a` that arrived before the webview was ready.
struct PendingOpenPaths {
    ready: bool,
    paths: Vec<String>,
}

fn urls_to_paths(urls: Vec<tauri::Url>) -> Vec<String> {
    urls.into_iter()
        .filter_map(|url| {
            url.to_file_path()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn emit_or_buffer_open_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let mut state = match app.state::<Mutex<PendingOpenPaths>>().lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    if state.ready {
        drop(state);
        let _ = app.emit("open-paths", paths);
    } else {
        state.paths.extend(paths);
    }
}

/// Called once the frontend has subscribed to `open-paths`.
#[tauri::command]
fn frontend_ready(app: AppHandle) -> Result<(), String> {
    let paths = {
        let mut state = app
            .state::<Mutex<PendingOpenPaths>>()
            .lock()
            .map_err(|e| e.to_string())?;
        state.ready = true;
        std::mem::take(&mut state.paths)
    };
    if !paths.is_empty() {
        app.emit("open-paths", paths).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub format: String,
    pub size: u64,
}

fn detect_format(path: &Path, bytes: &[u8]) -> Result<String, String> {
    // マジックバイト優先判定
    if bytes.starts_with(b"%PDF") {
        return Ok("pdf".to_string());
    }
    // XLSX / ZIP (PK header)
    if bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04]) {
        return match path.extension().and_then(|e| e.to_str()) {
            Some(ext) if ext.eq_ignore_ascii_case("xlsx") => Ok("xlsx".to_string()),
            _ => Err("Unsupported ZIP-based format".to_string()),
        };
    }
    // 拡張子フォールバック
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("csv") => Ok("csv".to_string()),
        Some("tsv") => Ok("tsv".to_string()),
        Some("md") | Some("markdown") => Ok("markdown".to_string()),
        Some("pdf") => Ok("pdf".to_string()),
        Some("xlsx") => Ok("xlsx".to_string()),
        Some(ext) => Err(format!("Unsupported format: {ext}")),
        None => Err("Cannot determine file format".to_string()),
    }
}

const MAX_OPEN_FILE_SIZE: u64 = 1024 * 1024 * 1024; // 1 GB

#[tauri::command(async)]
fn open_file(path: String) -> Result<FileInfo, String> {
    let p = Path::new(&path);
    let size = utils::assert_regular_file(p)?;
    if size > MAX_OPEN_FILE_SIZE {
        return Err(format!("File too large: {} bytes (max 1 GB)", size));
    }
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    // 先頭 8 バイトだけ読めばマジックバイト判定に十分
    let read_len = 8.min(size as usize);
    let mut buf = vec![0u8; read_len];
    if read_len > 0 {
        use std::io::Read;
        let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
        f.read_exact(&mut buf[..]).map_err(|e| e.to_string())?;
    }
    let format = detect_format(p, &buf)?;
    Ok(FileInfo {
        path,
        name,
        format,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn detect_csv_by_extension() {
        let p = Path::new("data.csv");
        assert_eq!(detect_format(p, b"col1,col2\n").unwrap(), "csv");
    }

    #[test]
    fn detect_tsv_by_extension() {
        let p = Path::new("data.tsv");
        assert_eq!(detect_format(p, b"col1\tcol2\n").unwrap(), "tsv");
    }

    #[test]
    fn detect_pdf_by_magic() {
        let p = Path::new("file.bin"); // 拡張子なしでもマジックバイトで判定
        assert_eq!(detect_format(p, b"%PDF-1.4 ...").unwrap(), "pdf");
    }

    #[test]
    fn detect_xlsx_by_magic_and_ext() {
        let p = Path::new("spreadsheet.xlsx");
        let magic = [0x50u8, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00];
        assert_eq!(detect_format(p, &magic).unwrap(), "xlsx");
    }

    #[test]
    fn detect_markdown_by_extension() {
        let p = Path::new("README.md");
        assert_eq!(detect_format(p, b"# Title\n").unwrap(), "markdown");
    }

    #[test]
    fn unsupported_format_returns_err() {
        let p = Path::new("photo.jpg");
        assert!(detect_format(p, b"\xFF\xD8\xFF").is_err());
    }

    #[test]
    fn urls_to_paths_converts_file_urls() {
        let url = tauri::Url::parse("file:///tmp/sample.csv").unwrap();
        let paths = urls_to_paths(vec![url]);
        assert_eq!(paths, vec!["/tmp/sample.csv"]);
    }

    #[test]
    fn urls_to_paths_skips_non_file_urls() {
        let url = tauri::Url::parse("https://example.com/a.csv").unwrap();
        let paths = urls_to_paths(vec![url]);
        assert!(paths.is_empty());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(file_watcher_commands::WatcherState(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
        .manage(csv_commands::CsvCache::default())
        .manage(Mutex::new(PendingOpenPaths {
            ready: false,
            paths: Vec::new(),
        }))
        .invoke_handler(tauri::generate_handler![
            open_file,
            frontend_ready,
            csv_commands::detect_encoding,
            csv_commands::read_csv,
            csv_commands::read_csv_chunk,
            csv_commands::close_csv,
            csv_commands::filter_csv,
            csv_commands::sort_csv,
            csv_commands::search_csv,
            csv_commands::export_csv,
            pdf_commands::read_pdf_bytes,
            pdf_commands::save_annotations,
            pdf_commands::load_annotations,
            markdown_commands::read_markdown,
            markdown_commands::save_markdown,
            markdown_commands::render_markdown_string,
            xlsx_commands::read_xlsx,
            xlsx_commands::read_xlsx_sheet,
            xlsx_commands::export_xlsx_sheet_as_csv,
            file_watcher_commands::watch_file,
            file_watcher_commands::unwatch_file,
            persistence_commands::save_app_data,
            persistence_commands::load_app_data,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                emit_or_buffer_open_paths(app, urls_to_paths(urls));
            } else {
                let _ = app;
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            {
                let _ = (app, event);
            }
        });
}
