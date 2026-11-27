use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::ipc::Response;

// ─── Commands ─────────────────────────────────────────────────────────────────

const MAX_PDF_SIZE: u64 = 512 * 1024 * 1024; // 512 MB
const CONTENT_SAMPLE_BYTES: u64 = 64 * 1024; // 64 KiB head / tail
const MAX_ANNOTATION_FILE_BYTES: u64 = 10 * 1024 * 1024;
const ANNOTATION_EXTENSIONS: &[&str] = &["json"];

/// Reads a PDF file as raw bytes (no base64) for PDF.js via tauri::ipc::Response.
#[tauri::command(async)]
pub fn read_pdf_bytes(path: String) -> Result<Response, String> {
    let size = crate::utils::assert_regular_file(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to read file: {}", e))?;
    if size > MAX_PDF_SIZE {
        return Err(format!("PDF too large: {} bytes (max 512 MB)", size));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    // 任意のファイルの中身を返さないよう、PDF ヘッダ (先頭 1024 バイト以内の %PDF-) を確認する
    if !bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|w| w == b"%PDF-")
    {
        return Err(format!("Not a PDF file: {}", path));
    }
    Ok(Response::new(bytes))
}

// ─── Annotation Persistence ───────────────────────────────────────────────────

/// Legacy key: SHA-256 of the absolute path string.
fn path_annotation_key(pdf_path: &str) -> String {
    Sha256::digest(pdf_path.as_bytes())
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// Content-based key: SHA-256 of (file size || head bytes || tail bytes).
/// Survives rename/move as long as file contents are unchanged.
fn content_annotation_key(pdf_path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(pdf_path).map_err(|e| format!("Failed to stat PDF: {}", e))?;
    let size = meta.len();

    let mut file =
        std::fs::File::open(pdf_path).map_err(|e| format!("Failed to open PDF: {}", e))?;

    let head_len = CONTENT_SAMPLE_BYTES.min(size) as usize;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head)
        .map_err(|e| format!("Failed to read PDF head: {}", e))?;

    let mut tail = Vec::new();
    if size > CONTENT_SAMPLE_BYTES {
        let tail_len = CONTENT_SAMPLE_BYTES.min(size - CONTENT_SAMPLE_BYTES) as usize;
        file.seek(SeekFrom::End(-(tail_len as i64)))
            .map_err(|e| format!("Failed to seek PDF tail: {}", e))?;
        tail.resize(tail_len, 0);
        file.read_exact(&mut tail)
            .map_err(|e| format!("Failed to read PDF tail: {}", e))?;
    }

    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());
    hasher.update(&head);
    hasher.update(&tail);
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect())
}

fn annotations_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("annotations");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn annotation_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.json", key))
}

fn read_annotation_file(file: &Path) -> Result<Option<String>, String> {
    if !file.exists() {
        return Ok(None);
    }
    let meta = std::fs::metadata(file).map_err(|e| e.to_string())?;
    if meta.len() > MAX_ANNOTATION_FILE_BYTES {
        // 空として返すとフロントがそれを保存して既存の注釈を消すため、エラーで読み込みを止める
        return Err("annotation sidecar exceeds size limit (10 MB)".to_string());
    }
    let content = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

/// Resolve the content-based key and migrate a legacy path-based sidecar if needed.
fn resolve_content_key_with_migration(
    dir: &Path,
    pdf_path: &str,
) -> Result<(String, PathBuf), String> {
    let content_key = content_annotation_key(Path::new(pdf_path))?;
    let content_file = annotation_file(dir, &content_key);

    if !content_file.exists() {
        let legacy_key = path_annotation_key(pdf_path);
        let legacy_file = annotation_file(dir, &legacy_key);
        if let Some(json) = read_annotation_file(&legacy_file)? {
            crate::utils::atomic_write(&content_file, json.as_bytes())
                .map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&legacy_file);
        }
    }

    Ok((content_key, content_file))
}

#[tauri::command(async)]
pub fn save_annotations(
    app: tauri::AppHandle,
    pdf_path: String,
    annotations_json: String,
) -> Result<(), String> {
    if annotations_json.len() as u64 > MAX_ANNOTATION_FILE_BYTES {
        // 書けても次回の読み込みで上限超過になり、注釈を開けなくなる
        return Err("annotations exceed size limit (10 MB)".to_string());
    }
    let dir = annotations_dir(&app)?;
    let (_key, file) = resolve_content_key_with_migration(&dir, &pdf_path)?;
    crate::utils::atomic_write(&file, annotations_json.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn load_annotations(app: tauri::AppHandle, pdf_path: String) -> Result<String, String> {
    let dir = annotations_dir(&app)?;
    let (_key, file) = resolve_content_key_with_migration(&dir, &pdf_path)?;
    Ok(read_annotation_file(&file)?.unwrap_or_else(|| "[]".to_string()))
}

/// Export annotations for a PDF to a user-chosen JSON file.
#[tauri::command(async)]
pub fn export_annotations(
    app: tauri::AppHandle,
    pdf_path: String,
    output_path: String,
) -> Result<(), String> {
    let output = Path::new(&output_path);
    crate::utils::require_extension(output, ANNOTATION_EXTENSIONS)?;
    // 保存はシンボリックリンクの先を置き換えるので、リンク先も .json でなければ書かない
    if let Ok(resolved) = std::fs::canonicalize(output) {
        crate::utils::require_extension(&resolved, ANNOTATION_EXTENSIONS)?;
    }
    let json = load_annotations(app, pdf_path)?;
    crate::utils::atomic_write_user_file(output, json.as_bytes())
        .map_err(|e| format!("Failed to export annotations: {}", e))
}

/// Import annotations from a JSON file and persist them under the content key.
/// Returns the imported JSON so the frontend can refresh its store.
#[tauri::command(async)]
pub fn import_annotations(
    app: tauri::AppHandle,
    pdf_path: String,
    input_path: String,
) -> Result<String, String> {
    crate::utils::require_extension(Path::new(&input_path), ANNOTATION_EXTENSIONS)?;
    let raw = std::fs::read_to_string(&input_path)
        .map_err(|e| format!("Failed to read import file: {}", e))?;
    if raw.len() as u64 > MAX_ANNOTATION_FILE_BYTES {
        return Err("Import file too large (max 10 MB)".to_string());
    }
    // Validate JSON is an array (annotation list)
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid annotation JSON: {}", e))?;
    if !parsed.is_array() {
        return Err("Annotation JSON must be an array".to_string());
    }
    let normalized = parsed.to_string();
    save_annotations(app, pdf_path, normalized.clone())?;
    Ok(normalized)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp_pdf(bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qv_annot_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.pdf");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path
    }

    #[test]
    fn test_read_pdf_bytes_invalid_path() {
        let result = read_pdf_bytes("/nonexistent/file.pdf".to_string());
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(
            err.contains("Failed to read file"),
            "Unexpected error: {}",
            err
        );
    }

    #[test]
    fn read_pdf_bytes_rejects_non_pdf_files() {
        let path = std::env::temp_dir().join(format!("qv_notpdf_{}.pdf", std::process::id()));
        std::fs::write(&path, b"-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        let r = read_pdf_bytes(path.to_string_lossy().into_owned());
        std::fs::remove_file(&path).ok();
        assert!(r.is_err());
    }

    #[test]
    fn oversized_sidecar_is_an_error_not_an_empty_list() {
        let pdf = write_temp_pdf(b"%PDF-1.4");
        let sidecar = pdf.parent().unwrap().join("big.json");
        let f = std::fs::File::create(&sidecar).unwrap();
        f.set_len(MAX_ANNOTATION_FILE_BYTES + 1).unwrap();
        let r = read_annotation_file(&sidecar);
        let _ = std::fs::remove_dir_all(pdf.parent().unwrap());
        assert!(r.is_err());
    }

    #[test]
    fn test_path_annotation_key_is_hex() {
        let key = path_annotation_key("/some/path/doc.pdf");
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_path_annotation_key_is_deterministic() {
        let k1 = path_annotation_key("/foo/bar.pdf");
        let k2 = path_annotation_key("/foo/bar.pdf");
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_path_annotation_key_differs_for_different_paths() {
        let k1 = path_annotation_key("/foo/bar.pdf");
        let k2 = path_annotation_key("/foo/baz.pdf");
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_content_key_stable_across_rename() {
        let bytes = b"%PDF-1.4 sample content for annotation key test";
        let path_a = write_temp_pdf(bytes);
        let key_a = content_annotation_key(&path_a).unwrap();

        let path_b = path_a.parent().unwrap().join("renamed.pdf");
        std::fs::rename(&path_a, &path_b).unwrap();
        let key_b = content_annotation_key(&path_b).unwrap();
        assert_eq!(key_a, key_b);

        let _ = std::fs::remove_dir_all(path_b.parent().unwrap());
    }

    #[test]
    fn test_content_key_differs_for_different_content() {
        let path_a = write_temp_pdf(b"%PDF-1.4 content A xxxxxxxxxxxxxxxxxxxxxxxx");
        let path_b = write_temp_pdf(b"%PDF-1.4 content B yyyyyyyyyyyyyyyyyyyyyyyy");
        let key_a = content_annotation_key(&path_a).unwrap();
        let key_b = content_annotation_key(&path_b).unwrap();
        assert_ne!(key_a, key_b);
        let _ = std::fs::remove_dir_all(path_a.parent().unwrap());
        let _ = std::fs::remove_dir_all(path_b.parent().unwrap());
    }

    #[test]
    fn test_migrate_legacy_path_key() {
        let bytes = b"%PDF-1.4 migration test payload";
        let pdf = write_temp_pdf(bytes);
        let pdf_str = pdf.to_string_lossy().to_string();

        let dir = pdf.parent().unwrap().join("annotations");
        std::fs::create_dir_all(&dir).unwrap();

        let legacy = annotation_file(&dir, &path_annotation_key(&pdf_str));
        std::fs::write(&legacy, r#"[{"id":"1","type":"note"}]"#).unwrap();

        let (content_key, content_file) =
            resolve_content_key_with_migration(&dir, &pdf_str).unwrap();
        assert!(content_file.exists());
        assert!(!legacy.exists());
        assert_eq!(
            std::fs::read_to_string(&content_file).unwrap(),
            r#"[{"id":"1","type":"note"}]"#
        );
        assert_eq!(content_key, content_annotation_key(&pdf).unwrap());

        let _ = std::fs::remove_dir_all(pdf.parent().unwrap());
    }
}
