use sha2::{Digest, Sha256};
use tauri::ipc::Response;

// ─── Commands ─────────────────────────────────────────────────────────────────

const MAX_PDF_SIZE: u64 = 512 * 1024 * 1024; // 512 MB

/// Reads a PDF file as raw bytes (no base64) for PDF.js via tauri::ipc::Response.
#[tauri::command(async)]
pub fn read_pdf_bytes(path: String) -> Result<Response, String> {
    let size = crate::utils::assert_regular_file(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to read file: {}", e))?;
    if size > MAX_PDF_SIZE {
        return Err(format!("PDF too large: {} bytes (max 512 MB)", size));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(Response::new(bytes))
}

// ─── Annotation Persistence ───────────────────────────────────────────────────

fn annotation_key(pdf_path: &str) -> String {
    Sha256::digest(pdf_path.as_bytes())
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[tauri::command(async)]
pub fn save_annotations(
    app: tauri::AppHandle,
    pdf_path: String,
    annotations_json: String,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("annotations");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key = annotation_key(&pdf_path);
    let file = dir.join(format!("{}.json", key));
    crate::utils::atomic_write(&file, annotations_json.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn load_annotations(app: tauri::AppHandle, pdf_path: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("annotations");
    let key = annotation_key(&pdf_path);
    let file = dir.join(format!("{}.json", key));
    if !file.exists() {
        return Ok("[]".to_string());
    }
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        // 巨大な sidecar は破損とみなし無視
        return Ok("[]".to_string());
    }
    std::fs::read_to_string(&file).map_err(|e| e.to_string())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_pdf_bytes_invalid_path() {
        let result = read_pdf_bytes("/nonexistent/file.pdf".to_string());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed to read file"),
            "Unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_annotation_key_is_hex() {
        let key = annotation_key("/some/path/doc.pdf");
        assert_eq!(key.len(), 64); // SHA-256 = 32 bytes = 64 hex chars
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_annotation_key_is_deterministic() {
        let k1 = annotation_key("/foo/bar.pdf");
        let k2 = annotation_key("/foo/bar.pdf");
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_annotation_key_differs_for_different_paths() {
        let k1 = annotation_key("/foo/bar.pdf");
        let k2 = annotation_key("/foo/baz.pdf");
        assert_ne!(k1, k2);
    }
}
