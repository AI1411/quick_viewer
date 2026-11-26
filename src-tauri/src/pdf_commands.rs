use lopdf::Document;
use pdfium_render::prelude::*;
use base64::{Engine as _, engine::general_purpose};
use image::ImageFormat;
use serde::Serialize;
use sha2::{Sha256, Digest};
use std::io::Cursor;

// ─── Data Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct PdfInfo {
    pub page_count: usize,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub creation_date: Option<String>,
    pub modification_date: Option<String>,
    pub encrypted: bool,
    pub outlines: Vec<OutlineItem>,
}

#[derive(Debug, Serialize, Clone)]
pub struct OutlineItem {
    pub title: String,
    pub page: Option<u32>, // 0-based page index
    pub level: u32,
    pub children: Vec<OutlineItem>,
}

#[derive(Debug, Serialize)]
pub struct PdfPageData {
    pub page_index: u32,
    pub width: u32,
    pub height: u32,
    pub image_base64: String, // PNG encoded as base64
}

// ─── PDF String Decoding ──────────────────────────────────────────────────────

fn decode_pdf_string(raw: &[u8]) -> String {
    // UTF-16BE BOM (FE FF) = Unicode string in PDF spec
    if raw.starts_with(&[0xFE, 0xFF]) {
        let utf16: Vec<u16> = raw[2..]
            .chunks_exact(2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
            .collect();
        return String::from_utf16_lossy(&utf16).to_string();
    }
    // Default: UTF-8 / Latin-1 passthrough
    String::from_utf8_lossy(raw).to_string()
}

// ─── Outline (Bookmark) Extraction ───────────────────────────────────────────

const MAX_OUTLINE_DEPTH: u32 = 50;
const MAX_OUTLINE_ITEMS: usize = 10_000;

fn extract_outlines(doc: &Document) -> Vec<OutlineItem> {
    let catalog_ref = match doc.trailer.get(b"Root").and_then(|r| r.as_reference()) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let catalog = match doc.get_dictionary(catalog_ref) {
        Ok(d) => d.clone(),
        Err(_) => return vec![],
    };
    let outlines_ref = match catalog.get(b"Outlines").and_then(|r| r.as_reference()) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let outlines_dict = match doc.get_dictionary(outlines_ref) {
        Ok(d) => d.clone(),
        Err(_) => return vec![],
    };
    let first_ref = match outlines_dict.get(b"First").and_then(|r| r.as_reference()) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    // しおりの項目ごとに get_pages() を作り直すと O(項目数 × ページ数) になるため 1 回だけ作る
    let page_index: PageIndex = doc
        .get_pages()
        .into_iter()
        .map(|(num, id)| (id, num.saturating_sub(1)))
        .collect();
    let mut visited = std::collections::HashSet::new();
    let mut count = 0usize;
    collect_outline_items(doc, &page_index, first_ref, 0, &mut visited, &mut count)
}

/// ページのオブジェクト ID → 0 始まりのページ番号
type PageIndex = std::collections::HashMap<lopdf::ObjectId, u32>;

fn collect_outline_items(
    doc: &Document,
    page_index: &PageIndex,
    start_ref: lopdf::ObjectId,
    level: u32,
    visited: &mut std::collections::HashSet<lopdf::ObjectId>,
    count: &mut usize,
) -> Vec<OutlineItem> {
    if level > MAX_OUTLINE_DEPTH {
        return vec![];
    }
    let mut items = Vec::new();
    let mut current_ref = start_ref;

    loop {
        if *count >= MAX_OUTLINE_ITEMS {
            break;
        }
        if !visited.insert(current_ref) {
            // 循環参照を検出 → 終了
            break;
        }
        *count += 1;

        let dict = match doc.get_dictionary(current_ref) {
            Ok(d) => d.clone(),
            Err(_) => break,
        };

        let title = dict
            .get(b"Title")
            .ok()
            .and_then(|t| t.as_str().ok())
            .map(decode_pdf_string)
            .unwrap_or_else(|| "(Untitled)".to_string());

        let page = extract_dest_page(doc, page_index, &dict);

        let children = dict
            .get(b"First")
            .ok()
            .and_then(|r| r.as_reference().ok())
            .map(|first_ref| {
                collect_outline_items(doc, page_index, first_ref, level + 1, visited, count)
            })
            .unwrap_or_default();

        items.push(OutlineItem { title, page, level, children });

        match dict.get(b"Next").and_then(|r| r.as_reference()) {
            Ok(next_ref) => current_ref = next_ref,
            Err(_) => break,
        }
    }

    items
}

fn extract_dest_page(doc: &Document, page_index: &PageIndex, dict: &lopdf::Dictionary) -> Option<u32> {
    if let Ok(dest) = dict.get(b"Dest") {
        return page_from_dest(doc, page_index, dest);
    }
    if let Ok(action_ref) = dict.get(b"A").and_then(|a| a.as_reference()) {
        if let Ok(action) = doc.get_dictionary(action_ref) {
            let action = action.clone();
            if let Ok(dest) = action.get(b"D") {
                return page_from_dest(doc, page_index, dest);
            }
        }
    }
    None
}

fn page_from_dest(doc: &Document, page_index: &PageIndex, dest: &lopdf::Object) -> Option<u32> {
    let first_elem = match dest {
        lopdf::Object::Array(a) => a.first()?,
        lopdf::Object::Reference(r) => {
            if let Ok(obj) = doc.get_object(*r) {
                if let lopdf::Object::Array(a) = obj {
                    return page_ref_to_number(page_index, a.first()?);
                }
            }
            return None;
        }
        _ => return None,
    };
    page_ref_to_number(page_index, first_elem)
}

fn page_ref_to_number(page_index: &PageIndex, obj: &lopdf::Object) -> Option<u32> {
    page_index.get(&obj.as_reference().ok()?).copied()
}

// ─── pdfium-render Loader ─────────────────────────────────────────────────────

/// libpdfium を探す場所。カレントディレクトリやシステムの検索パスは使わない
/// (ターミナルから細工したディレクトリで起動すると、そこの dylib を読み込んでしまうため)。
fn pdfium_library_candidates() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        // macOS の .app では bundle.macOS.frameworks により Contents/Frameworks に入る
        dirs.push(exe_dir.join("../Frameworks"));
        dirs.push(exe_dir.clone());
    }
    if cfg!(debug_assertions) {
        dirs.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("pdfium/lib"));
    }
    dirs.into_iter()
        .map(|d| std::path::PathBuf::from(Pdfium::pdfium_platform_library_name_at_path(&d)))
        .collect()
}

/// thread_safe 機能では Pdfium インスタンスの生存中ずっとグローバルロックを握るため、
/// インスタンスは呼び出しごとに作る。探索結果のライブラリパスだけを使い回す。
fn get_pdfium() -> Result<Pdfium, String> {
    static LIBRARY: std::sync::OnceLock<Result<std::path::PathBuf, String>> = std::sync::OnceLock::new();
    let library = LIBRARY
        .get_or_init(|| {
            let candidates = pdfium_library_candidates();
            candidates
                .iter()
                .find(|p| p.is_file())
                .cloned()
                .ok_or_else(|| format!("pdfium library not found (searched: {:?})", candidates))
        })
        .as_ref()
        .map_err(|e| e.clone())?;
    Pdfium::bind_to_library(library)
        .map(Pdfium::new)
        .map_err(|e| format!("failed to load pdfium: {}", e))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const MAX_PDF_SIZE: u64 = 512 * 1024 * 1024; // 512 MB

/// Returns PDF metadata, page count, and outline (bookmarks).
#[tauri::command(async)]
pub fn read_pdf_info(path: String) -> Result<PdfInfo, String> {
    crate::utils::catch_panic(move || {
        crate::utils::assert_regular_file(std::path::Path::new(&path))
            .map_err(|e| format!("Failed to load PDF: {}", e))?;

        let doc = Document::load(&path)
            .map_err(|e| format!("Failed to load PDF: {}", e))?;

        let page_count = doc.get_pages().len();
        let encrypted = doc.is_encrypted();

        let mut title = None;
        let mut author = None;
        let mut subject = None;
        let mut creator = None;
        let mut producer = None;
        let mut creation_date = None;
        let mut modification_date = None;

        if let Ok(info_ref) = doc.trailer.get(b"Info").and_then(|r| r.as_reference()) {
            if let Ok(info_dict) = doc.get_dictionary(info_ref) {
                let info_dict = info_dict.clone();
                for (key, value) in info_dict.iter() {
                    if let Ok(raw) = value.as_str() {
                        let text = decode_pdf_string(raw);
                        match key.as_slice() {
                            b"Title" => title = Some(text),
                            b"Author" => author = Some(text),
                            b"Subject" => subject = Some(text),
                            b"Creator" => creator = Some(text),
                            b"Producer" => producer = Some(text),
                            b"CreationDate" => creation_date = Some(text),
                            b"ModDate" => modification_date = Some(text),
                            _ => {}
                        }
                    }
                }
            }
        }

        let outlines = extract_outlines(&doc);

        Ok(PdfInfo {
            page_count,
            title,
            author,
            subject,
            creator,
            producer,
            creation_date,
            modification_date,
            encrypted,
            outlines,
        })
    })
}

/// Renders a single PDF page to a base64-encoded PNG image.
/// `page_index` is 0-based. `scale` controls render resolution (default 1.5).
#[tauri::command(async)]
pub fn read_pdf_page(path: String, page_index: u32, scale: Option<f32>) -> Result<PdfPageData, String> {
    crate::utils::catch_panic(move || {
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
    })
}

/// Reads a file as raw bytes and returns it base64-encoded.
/// Used by the frontend to load PDFs into PDF.js without asset protocol.
#[tauri::command(async)]
pub fn read_pdf_bytes(path: String) -> Result<String, String> {
    let size = crate::utils::assert_regular_file(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to read file: {}", e))?;
    if size > MAX_PDF_SIZE {
        return Err(format!("PDF too large: {} bytes (max 512 MB)", size));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    // 任意のファイルの中身を返さないよう、PDF ヘッダ (先頭 1024 バイト以内の %PDF-) を確認する
    if !bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-") {
        return Err(format!("Not a PDF file: {}", path));
    }
    Ok(general_purpose::STANDARD.encode(bytes))
}

// ─── Annotation Persistence ───────────────────────────────────────────────────

const MAX_ANNOTATIONS_SIZE: u64 = 10 * 1024 * 1024; // 10 MB

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
    if annotations_json.len() as u64 > MAX_ANNOTATIONS_SIZE {
        return Err("annotations exceed size limit (10 MB)".to_string());
    }
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
    if meta.len() > MAX_ANNOTATIONS_SIZE {
        // "[]" を返すとフロントがそれを保存して既存の注釈を消すため、エラーで読み込みを止める
        return Err("annotation sidecar exceeds size limit (10 MB)".to_string());
    }
    std::fs::read_to_string(&file).map_err(|e| e.to_string())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outline_destinations_resolve_to_zero_based_pages() {
        use lopdf::{dictionary, Object};
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let p1 = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id });
        let p2 = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![p1.into(), p2.into()],
                "Count" => 2,
            }),
        );
        let first = doc.new_object_id();
        let second = doc.new_object_id();
        let outlines = doc.add_object(dictionary! { "Type" => "Outlines", "First" => first, "Last" => second });
        doc.objects.insert(
            first,
            Object::Dictionary(dictionary! {
                "Title" => Object::string_literal("Intro"),
                "Parent" => outlines,
                "Next" => second,
                "Dest" => vec![p1.into(), "Fit".into()],
            }),
        );
        doc.objects.insert(
            second,
            Object::Dictionary(dictionary! {
                "Title" => Object::string_literal("Chapter 2"),
                "Parent" => outlines,
                "Dest" => vec![p2.into(), "Fit".into()],
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id, "Outlines" => outlines });
        doc.trailer.set("Root", catalog);

        let items = extract_outlines(&doc);
        let got: Vec<(&str, Option<u32>)> = items.iter().map(|i| (i.title.as_str(), i.page)).collect();
        assert_eq!(got, vec![("Intro", Some(0)), ("Chapter 2", Some(1))]);
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
    fn pdfium_is_searched_only_at_absolute_paths() {
        let candidates = pdfium_library_candidates();
        assert!(!candidates.is_empty());
        assert!(candidates.iter().all(|p| p.is_absolute()), "{:?}", candidates);
    }

    #[test]
    fn read_pdf_page_renders_with_bundled_pdfium() {
        let path = std::env::temp_dir().join(format!("qv_render_{}.pdf", std::process::id()));
        std::fs::write(
            &path,
            b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
        )
        .unwrap();
        let page = read_pdf_page(path.to_string_lossy().into_owned(), 0, Some(0.5));
        std::fs::remove_file(&path).ok();
        let page = page.expect("page renders");
        assert!(page.width > 0 && page.height > page.width);
    }

    #[test]
    fn test_read_pdf_info_invalid_path() {
        let result = read_pdf_info("/nonexistent/file.pdf".to_string());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed"),
            "Expected 'Failed' in error, got: {}",
            err
        );
    }

    #[test]
    fn test_decode_pdf_string_utf8() {
        let input = b"Hello, World!";
        assert_eq!(decode_pdf_string(input), "Hello, World!");
    }

    #[test]
    fn test_decode_pdf_string_utf16be() {
        // BOM (FE FF) + "Hi" in UTF-16BE: 00 48 00 69
        let input = vec![0xFE_u8, 0xFF, 0x00, 0x48, 0x00, 0x69];
        assert_eq!(decode_pdf_string(&input), "Hi");
    }

    #[test]
    fn test_decode_pdf_string_empty() {
        assert_eq!(decode_pdf_string(b""), "");
    }

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
