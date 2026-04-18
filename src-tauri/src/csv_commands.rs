use chardetng::EncodingDetector;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;

// ─── Data Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CsvMeta {
    pub total_rows: usize,
    pub columns: usize,
    pub encoding: String,
    pub delimiter: String,
    pub headers: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CsvData {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub meta: CsvMeta,
}

#[derive(Debug, Serialize)]
pub struct CsvChunk {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub offset: usize,
    pub total_rows: usize,
}

#[derive(Debug, Deserialize)]
pub struct FilterCondition {
    pub column: String,
    /// "exact" | "contains" | "starts_with" | "regex" | "gt" | "lt" | "gte" | "lte" | "eq_num"
    pub filter_type: String,
    pub value: String,
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/// ファイルバイト列をエンコーディング自動検出してデコードし、(テキスト, エンコーディング名) を返す。
pub(crate) fn decode_file(raw: &[u8]) -> (String, String) {
    // UTF-8 BOM を除去してからデコード
    let raw = raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(raw);

    let mut detector = EncodingDetector::new();
    detector.feed(raw, true);
    let encoding = detector.guess(None, true);
    let (cow, _, _) = encoding.decode(raw);
    (cow.into_owned(), encoding.name().to_string())
}

/// 先頭 5 行のサンプルから最も多く現れる区切り文字を返す（クォート内は除外）。
pub(crate) fn detect_delimiter_auto(sample: &str) -> u8 {
    let sample_lines: Vec<&str> = sample.lines().take(5).collect();

    let count_unquoted = |line: &str, delim: char| -> usize {
        let mut count = 0usize;
        let mut in_quote = false;
        for ch in line.chars() {
            if ch == '"' {
                in_quote = !in_quote;
            } else if !in_quote && ch == delim {
                count += 1;
            }
        }
        count
    };

    let candidates: &[(u8, char)] = &[(b',', ','), (b'\t', '\t'), (b';', ';'), (b'|', '|')];
    candidates
        .iter()
        .max_by_key(|(_, c)| {
            sample_lines.iter().map(|line| count_unquoted(line, *c)).sum::<usize>()
        })
        .map(|(d, _)| *d)
        .unwrap_or(b',')
}

/// Option<String> から区切り文字バイトを解決する。None の場合は自動検出。
pub(crate) fn parse_delimiter(d: Option<String>, content: &str) -> u8 {
    match d.as_deref() {
        Some("comma") | Some(",") => b',',
        Some("tab") | Some("\t") => b'\t',
        Some("semicolon") | Some(";") => b';',
        Some("pipe") | Some("|") => b'|',
        Some(s) if s.len() == 1 => s.bytes().next().unwrap_or(b','),
        _ => detect_delimiter_auto(content),
    }
}

/// CSV 文字列のデータ行数（ヘッダ除く）を数える。
fn count_rows(content: &str, delimiter: u8) -> usize {
    csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes())
        .records()
        .count()
}

/// ヘッダと行を最大列数に合わせて padding する（flexible モードで列数が不揃いな場合に使用）。
fn normalize_columns(headers: &mut Vec<String>, rows: &mut [Vec<String>]) {
    let max_cols = rows
        .iter()
        .map(|r| r.len())
        .max()
        .unwrap_or(0)
        .max(headers.len());
    while headers.len() < max_cols {
        headers.push(format!("Column {}", headers.len() + 1));
    }
    for row in rows.iter_mut() {
        while row.len() < max_cols {
            row.push(String::new());
        }
    }
}

/// 1 つのフィルタ条件に対してセル値が合致するか判定する。
fn row_matches(value: &str, condition: &FilterCondition) -> bool {
    match condition.filter_type.as_str() {
        "exact" => value == condition.value,
        "contains" => value.contains(&condition.value),
        "starts_with" => value.starts_with(&condition.value),
        "regex" => Regex::new(&condition.value)
            .map(|re| re.is_match(value))
            .unwrap_or(false),
        "gt" => parse_f64(value)
            .zip(parse_f64(&condition.value))
            .map(|(a, b)| a > b)
            .unwrap_or(false),
        "lt" => parse_f64(value)
            .zip(parse_f64(&condition.value))
            .map(|(a, b)| a < b)
            .unwrap_or(false),
        "gte" => parse_f64(value)
            .zip(parse_f64(&condition.value))
            .map(|(a, b)| a >= b)
            .unwrap_or(false),
        "lte" => parse_f64(value)
            .zip(parse_f64(&condition.value))
            .map(|(a, b)| a <= b)
            .unwrap_or(false),
        "eq_num" => parse_f64(value)
            .zip(parse_f64(&condition.value))
            .map(|(a, b)| (a - b).abs() < f64::EPSILON)
            .unwrap_or(false),
        _ => false,
    }
}

fn parse_f64(s: &str) -> Option<f64> {
    s.parse::<f64>().ok()
}

/// 複数フィルタ条件（AND）を全行に適用して合致行を返す。
pub(crate) fn apply_filters(
    headers: &[String],
    rows: &[Vec<String>],
    conditions: &[FilterCondition],
) -> Vec<Vec<String>> {
    rows.iter()
        .filter(|row| {
            conditions.iter().all(|cond| {
                match headers.iter().position(|h| h == &cond.column) {
                    Some(idx) => {
                        row_matches(row.get(idx).map(|s| s.as_str()).unwrap_or(""), cond)
                    }
                    None => false,
                }
            })
        })
        .cloned()
        .collect()
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

const MAX_CSV_SIZE: u64 = 512 * 1024 * 1024; // 512 MB

fn check_csv_file(path: &str) -> Result<(), String> {
    let size = crate::utils::assert_regular_file(std::path::Path::new(path))?;
    if size > MAX_CSV_SIZE {
        return Err(format!("CSV file too large: {} bytes (max 512 MB)", size));
    }
    Ok(())
}

/// ファイルのテキストエンコーディングを検出して返す。
#[tauri::command]
pub fn detect_encoding(path: String) -> Result<String, String> {
    check_csv_file(&path)?;
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let (_, encoding_name) = decode_file(&raw);
    Ok(encoding_name)
}

/// CSV ファイルを読み込む。先頭 limit 行（デフォルト 100）とメタデータを返す。
#[tauri::command]
pub fn read_csv(
    path: String,
    delimiter: Option<String>,
    limit: Option<usize>,
) -> Result<CsvData, String> {
    check_csv_file(&path)?;
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, encoding_name) = decode_file(&raw);
    let delim = parse_delimiter(delimiter, &content);
    let delim_str = (delim as char).to_string();

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());

    let mut headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let max_rows = limit.unwrap_or(100);
    let mut rows: Vec<Vec<String>> = rdr
        .records()
        .take(max_rows)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| r.iter().map(|s| s.to_string()).collect())
        .collect();

    normalize_columns(&mut headers, &mut rows);

    let total_rows = count_rows(&content, delim);

    Ok(CsvData {
        headers: headers.clone(),
        rows,
        meta: CsvMeta {
            total_rows,
            columns: headers.len(),
            encoding: encoding_name,
            delimiter: delim_str,
            headers,
        },
    })
}

/// CSV ファイルのチャンク（offset 行目から limit 行）を返す。
#[tauri::command]
pub fn read_csv_chunk(
    path: String,
    delimiter: Option<String>,
    offset: usize,
    limit: usize,
) -> Result<CsvChunk, String> {
    check_csv_file(&path)?;
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, _) = decode_file(&raw);
    let delim = parse_delimiter(delimiter, &content);

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());

    let mut headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut rows: Vec<Vec<String>> = rdr
        .records()
        .skip(offset)
        .take(limit)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| r.iter().map(|s| s.to_string()).collect())
        .collect();

    normalize_columns(&mut headers, &mut rows);

    let total_rows = count_rows(&content, delim);

    Ok(CsvChunk {
        headers,
        rows,
        offset,
        total_rows,
    })
}

/// フィルタ条件（AND 複合）で絞り込んだ全行を返す。
#[tauri::command]
pub fn filter_csv(
    path: String,
    delimiter: Option<String>,
    conditions: Vec<FilterCondition>,
) -> Result<CsvData, String> {
    check_csv_file(&path)?;
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, encoding_name) = decode_file(&raw);
    let delim = parse_delimiter(delimiter, &content);
    let delim_str = (delim as char).to_string();

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());

    let mut headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut all_rows: Vec<Vec<String>> = rdr
        .records()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| r.iter().map(|s| s.to_string()).collect())
        .collect();

    normalize_columns(&mut headers, &mut all_rows);

    let filtered = if conditions.is_empty() {
        all_rows
    } else {
        apply_filters(&headers, &all_rows, &conditions)
    };

    let total_rows = filtered.len();

    Ok(CsvData {
        headers: headers.clone(),
        rows: filtered,
        meta: CsvMeta {
            total_rows,
            columns: headers.len(),
            encoding: encoding_name,
            delimiter: delim_str,
            headers,
        },
    })
}

/// フィルタ結果を CSV ファイルとして output_path に保存する。
#[tauri::command]
pub fn export_csv(
    path: String,
    delimiter: Option<String>,
    output_path: String,
    conditions: Vec<FilterCondition>,
) -> Result<(), String> {
    check_csv_file(&path)?;
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, _) = decode_file(&raw);
    let delim = parse_delimiter(delimiter, &content);

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());

    let mut headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut all_rows: Vec<Vec<String>> = rdr
        .records()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| r.iter().map(|s| s.to_string()).collect())
        .collect();

    normalize_columns(&mut headers, &mut all_rows);

    let filtered = if conditions.is_empty() {
        all_rows
    } else {
        apply_filters(&headers, &all_rows, &conditions)
    };

    let out_file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut wtr = csv::WriterBuilder::new()
        .delimiter(delim)
        .from_writer(out_file);

    wtr.write_record(&headers).map_err(|e| e.to_string())?;
    for row in &filtered {
        wtr.write_record(row).map_err(|e| e.to_string())?;
    }
    wtr.flush().map_err(|e| e.to_string())?;

    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_CSV: &str = "name,age,city\nAlice,30,Tokyo\nBob,25,Osaka\nCarol,35,Tokyo";
    const SAMPLE_TSV: &str = "name\tage\tcity\nAlice\t30\tTokyo\nBob\t25\tOsaka";

    #[test]
    fn detect_delimiter_comma() {
        assert_eq!(detect_delimiter_auto(SAMPLE_CSV), b',');
    }

    #[test]
    fn detect_delimiter_tab() {
        assert_eq!(detect_delimiter_auto(SAMPLE_TSV), b'\t');
    }

    #[test]
    fn parse_delimiter_explicit_tab() {
        assert_eq!(parse_delimiter(Some("tab".to_string()), ""), b'\t');
    }

    #[test]
    fn parse_delimiter_none_auto_detects_comma() {
        assert_eq!(parse_delimiter(None, SAMPLE_CSV), b',');
    }

    #[test]
    fn normalize_columns_pads_short_header_and_rows() {
        let mut headers = vec!["sep=,".to_string()];
        let mut rows = vec![
            vec!["a".into(), "b".into(), "c".into()],
            vec!["d".into(), "e".into()],
        ];
        normalize_columns(&mut headers, &mut rows);
        assert_eq!(headers, vec!["sep=,", "Column 2", "Column 3"]);
        assert_eq!(rows[0], vec!["a", "b", "c"]);
        assert_eq!(rows[1], vec!["d", "e", ""]);
    }

    #[test]
    fn row_matches_exact() {
        let cond = FilterCondition {
            column: "c".into(),
            filter_type: "exact".into(),
            value: "Tokyo".into(),
        };
        assert!(row_matches("Tokyo", &cond));
        assert!(!row_matches("Osaka", &cond));
    }

    #[test]
    fn row_matches_contains() {
        let cond = FilterCondition {
            column: "c".into(),
            filter_type: "contains".into(),
            value: "ky".into(),
        };
        assert!(row_matches("Tokyo", &cond));
        assert!(!row_matches("Osaka", &cond));
    }

    #[test]
    fn row_matches_starts_with() {
        let cond = FilterCondition {
            column: "c".into(),
            filter_type: "starts_with".into(),
            value: "To".into(),
        };
        assert!(row_matches("Tokyo", &cond));
        assert!(!row_matches("Osaka", &cond));
    }

    #[test]
    fn row_matches_regex() {
        let cond = FilterCondition {
            column: "c".into(),
            filter_type: "regex".into(),
            value: "^T.*o$".into(),
        };
        assert!(row_matches("Tokyo", &cond));
        assert!(!row_matches("Osaka", &cond));
    }

    #[test]
    fn row_matches_gt() {
        let cond = FilterCondition {
            column: "a".into(),
            filter_type: "gt".into(),
            value: "28".into(),
        };
        assert!(row_matches("30", &cond));
        assert!(!row_matches("25", &cond));
    }

    #[test]
    fn row_matches_lt() {
        let cond = FilterCondition {
            column: "a".into(),
            filter_type: "lt".into(),
            value: "30".into(),
        };
        assert!(row_matches("25", &cond));
        assert!(!row_matches("35", &cond));
    }

    #[test]
    fn row_matches_gte() {
        let cond = FilterCondition {
            column: "a".into(),
            filter_type: "gte".into(),
            value: "30".into(),
        };
        assert!(row_matches("30", &cond));
        assert!(row_matches("35", &cond));
        assert!(!row_matches("25", &cond));
    }

    #[test]
    fn row_matches_lte() {
        let cond = FilterCondition {
            column: "a".into(),
            filter_type: "lte".into(),
            value: "30".into(),
        };
        assert!(row_matches("30", &cond));
        assert!(row_matches("25", &cond));
        assert!(!row_matches("35", &cond));
    }

    #[test]
    fn apply_filters_and_logic() {
        let headers = vec!["name".to_string(), "age".to_string(), "city".to_string()];
        let rows = vec![
            vec!["Alice".to_string(), "30".to_string(), "Tokyo".to_string()],
            vec!["Bob".to_string(), "25".to_string(), "Osaka".to_string()],
            vec!["Carol".to_string(), "35".to_string(), "Tokyo".to_string()],
        ];
        let conditions = vec![
            FilterCondition {
                column: "city".into(),
                filter_type: "exact".into(),
                value: "Tokyo".into(),
            },
            FilterCondition {
                column: "age".into(),
                filter_type: "gt".into(),
                value: "28".into(),
            },
        ];
        let result = apply_filters(&headers, &rows, &conditions);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0][0], "Alice");
        assert_eq!(result[1][0], "Carol");
    }

    #[test]
    fn apply_filters_empty_conditions_returns_all() {
        let headers = vec!["name".to_string()];
        let rows = vec![
            vec!["Alice".to_string()],
            vec!["Bob".to_string()],
        ];
        let result = apply_filters(&headers, &rows, &[]);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn decode_file_utf8() {
        let data = b"hello, world";
        let (decoded, encoding) = decode_file(data);
        assert_eq!(decoded, "hello, world");
        assert!(!encoding.is_empty());
    }
}
