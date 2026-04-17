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

    (html_output, toc)
}

#[tauri::command]
pub fn read_markdown(path: String) -> Result<MarkdownResult, String> {
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (frontmatter, content) = parse_frontmatter(&raw);
    let (html, toc) = render_markdown(content);
    Ok(MarkdownResult { html, toc, frontmatter, raw })
}

#[tauri::command]
pub fn save_markdown(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
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
    fn test_read_markdown_nonexistent() {
        let result = read_markdown("/nonexistent/path/file.md".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_save_and_read_markdown_roundtrip() {
        let path = std::env::temp_dir().join("quickview_test_markdown.md");
        let path_str = path.to_string_lossy().to_string();
        let content = "---\ntitle: Test\nauthor: Alice\n---\n# Hello\n\nBody text.";

        save_markdown(path_str.clone(), content.to_string()).unwrap();
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
