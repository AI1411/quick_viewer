pub mod csv_commands;
pub mod utils;
pub mod file_watcher_commands;
pub mod markdown_commands;
pub mod pdf_commands;
pub mod persistence_commands;
pub mod xlsx_commands;

use serde::Serialize;
use std::fs;
use std::path::Path;

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

#[tauri::command]
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
    Ok(FileInfo { path, name, format, size })
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
    fn greet_returns_greeting() {
        let result = format!("Hello, {}! You've been greeted from Rust!", "QuickView");
        assert!(result.contains("QuickView"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(file_watcher_commands::WatcherState(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
        .invoke_handler(tauri::generate_handler![
            open_file,
            csv_commands::detect_encoding,
            csv_commands::read_csv,
            csv_commands::read_csv_chunk,
            csv_commands::filter_csv,
            csv_commands::export_csv,
            pdf_commands::read_pdf_info,
            pdf_commands::read_pdf_page,
            pdf_commands::read_pdf_bytes,
            pdf_commands::save_annotations,
            pdf_commands::load_annotations,
            markdown_commands::read_markdown,
            markdown_commands::save_markdown,
            xlsx_commands::read_xlsx,
            xlsx_commands::read_xlsx_sheet,
            xlsx_commands::export_xlsx_sheet_as_csv,
            file_watcher_commands::watch_file,
            file_watcher_commands::unwatch_file,
            persistence_commands::save_app_data,
            persistence_commands::load_app_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
