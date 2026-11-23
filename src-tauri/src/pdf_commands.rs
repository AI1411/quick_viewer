use pdfium_render::prelude::*;
use base64::{Engine as _, engine::general_purpose};
use image::ImageFormat;
use serde::Serialize;
use sha2::{Sha256, Digest};
use std::io::Cursor;
use tauri::ipc::Response;

// ─── Data Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct PdfPageData {
    pub page_index: u32,
    pub width: u32,
    pub height: u32,
    pub image_base64: String, // PNG encoded as base64
}

// ─── pdfium-render Loader ─────────────────────────────────────────────────────

fn get_pdfium() -> Result<Pdfium, String> {
    // Try dev path: src-tauri/pdfium/lib/libpdfium.dylib
    let dev_lib = std::env::current_dir()
        .ok()
        .map(|d| d.join("pdfium").join("lib"))
        .map(|p| Pdfium::pdfium_platform_library_name_at_path(p.to_string_lossy().as_ref()));

    if let Some(lib_path) = dev_lib {
        if let Ok(bindings) = Pdfium::bind_to_library(lib_path) {
            return Ok(Pdfium::new(bindings));
        }
    }

    // Fallback: system library
    Pdfium::bind_to_system_library()
        .map(Pdfium::new)
        .map_err(|e| format!(
            "pdfium library not found: {}. Place libpdfium.dylib in src-tauri/pdfium/lib/",
            e
        ))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const MAX_PDF_SIZE: u64 = 512 * 1024 * 1024; // 512 MB

/// Renders a single PDF page to a base64-encoded PNG image.
/// `page_index` is 0-based. `scale` controls render resolution (default 1.5).
#[tauri::command(async)]
pub fn read_pdf_page(path: String, page_index: u32, scale: Option<f32>) -> Result<PdfPageData, String> {
    crate::utils::assert_regular_file(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to load PDF: {}", e))?;

    let scale = scale.unwrap_or(1.5_f32);
    let target_width = (595.0 * scale) as i32; // A4 width in points × scale

    let pdfium = get_pdfium()?;

    let document = pdfium
        .load_pdf_from_file(&path, None)
        .map_err(|e| format!("Failed to load PDF: {}", e))?;

    let page_count = document.pages().len() as u32;
    if page_index >= page_count {
        return Err(format!(
            "Page index {} out of range (document has {} pages)",
            page_index, page_count
        ));
    }

    let render_config = PdfRenderConfig::new()
        .set_target_width(target_width)
        .set_maximum_height(4096);

    let page = document
        .pages()
        .get(page_index as u16)
        .map_err(|e| format!("Failed to get page {}: {}", page_index, e))?;

    let rendered = page
        .render_with_config(&render_config)
        .map_err(|e| format!("Failed to render page {}: {}", page_index, e))?;

    let img = rendered.as_image();
    let width = img.width();
    let height = img.height();

    let mut png_bytes: Vec<u8> = Vec::new();
    img.write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .map_err(|e| format!("Failed to encode page as PNG: {}", e))?;

    let image_base64 = general_purpose::STANDARD.encode(&png_bytes);

    Ok(PdfPageData {
        page_index,
        width,
        height,
        image_base64,
    })
}

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
    fn test_read_pdf_page_invalid_path() {
        // Either pdfium-not-found or file-not-found — both are valid errors
        let result = read_pdf_page("/nonexistent/file.pdf".to_string(), 0, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed") || err.contains("pdfium") || err.contains("not found"),
            "Unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_read_pdf_bytes_invalid_path() {
        let result = read_pdf_bytes("/nonexistent/file.pdf".to_string());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Failed to read file"), "Unexpected error: {}", err);
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
