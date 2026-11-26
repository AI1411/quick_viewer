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

/// ヘッダと行を max_cols 列に揃える（flexible モードで列数が不揃いな場合に使用）。
fn pad_columns(headers: &mut Vec<String>, rows: &mut [Vec<String>], max_cols: usize) {
    while headers.len() < max_cols {
        headers.push(format!("Column {}", headers.len() + 1));
    }
    for row in rows.iter_mut() {
        while row.len() < max_cols {
            row.push(String::new());
        }
    }
}

enum NumOp {
    Gt,
    Lt,
    Gte,
    Lte,
    Eq,
}

enum Matcher {
    Exact(String),
    Contains(String),
    StartsWith(String),
    /// 不正な正規表現は何にも合致しない
    Regex(Option<Regex>),
    Num(NumOp, Option<f64>),
    Never,
}

/// 列位置と判定方法を事前に解決したフィルタ条件。
/// 正規表現を行ごとにコンパイルしないよう、条件ごとに 1 回だけ作る。
pub(crate) struct CompiledFilter {
    column: Option<usize>,
    matcher: Matcher,
}

impl Matcher {
    fn new(condition: &FilterCondition) -> Matcher {
        let num = |op| Matcher::Num(op, parse_f64(&condition.value));
        match condition.filter_type.as_str() {
            "exact" => Matcher::Exact(condition.value.clone()),
            "contains" => Matcher::Contains(condition.value.clone()),
            "starts_with" => Matcher::StartsWith(condition.value.clone()),
            "regex" => Matcher::Regex(Regex::new(&condition.value).ok()),
            "gt" => num(NumOp::Gt),
            "lt" => num(NumOp::Lt),
            "gte" => num(NumOp::Gte),
            "lte" => num(NumOp::Lte),
            "eq_num" => num(NumOp::Eq),
            _ => Matcher::Never,
        }
    }

    fn matches(&self, value: &str) -> bool {
        match self {
            Matcher::Exact(v) => value == v,
            Matcher::Contains(v) => value.contains(v.as_str()),
            Matcher::StartsWith(v) => value.starts_with(v.as_str()),
            Matcher::Regex(re) => re.as_ref().is_some_and(|re| re.is_match(value)),
            Matcher::Num(op, Some(b)) => parse_f64(value).is_some_and(|a| match op {
                NumOp::Gt => a > *b,
                NumOp::Lt => a < *b,
                NumOp::Gte => a >= *b,
                NumOp::Lte => a <= *b,
                NumOp::Eq => (a - b).abs() < f64::EPSILON,
            }),
            Matcher::Num(_, None) | Matcher::Never => false,
        }
    }
}

pub(crate) fn compile_filters(
    headers: &[String],
    conditions: &[FilterCondition],
) -> Vec<CompiledFilter> {
    conditions
        .iter()
        .map(|cond| CompiledFilter {
            column: headers.iter().position(|h| h == &cond.column),
            matcher: Matcher::new(cond),
        })
        .collect()
}

/// 1 行が全フィルタ条件（AND）に合致するか判定する。
pub(crate) fn row_matches_all(filters: &[CompiledFilter], row: &[String]) -> bool {
    filters.iter().all(|f| match f.column {
        Some(idx) => f.matcher.matches(row.get(idx).map(|s| s.as_str()).unwrap_or("")),
        None => false,
    })
}

/// 1 つのフィルタ条件に対してセル値が合致するか判定する。
#[cfg(test)]
fn row_matches(value: &str, condition: &FilterCondition) -> bool {
    Matcher::new(condition).matches(value)
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
    let filters = compile_filters(headers, conditions);
    rows.iter()
        .filter(|row| row_matches_all(&filters, row))
        .cloned()
        .collect()
}

// ─── 解析済み CSV のキャッシュ ────────────────────────────────────────────────

const MAX_CSV_SIZE: u64 = 512 * 1024 * 1024; // 512 MB
/// この行数ごとにレコード先頭のバイト位置を記録し、チャンク読み込みで先頭から解析し直さない
const CHECKPOINT_INTERVAL: usize = 1_000;

/// 1 回の全件走査で得た CSV の情報。スクロールのたびにファイル全体を読み直し、
/// 2 回パースしていたのを、デコード済みの内容とレコード位置の索引で置き換える。
struct ParsedCsv {
    content: String,
    encoding: String,
    delimiter: u8,
    headers: Vec<String>,
    total_rows: usize,
    /// ファイル全体での最大列数 (100 行目以降で増える列にもヘッダを付ける)
    max_cols: usize,
    /// checkpoints[i] = (i * CHECKPOINT_INTERVAL) 番目のデータ行の先頭バイト位置
    checkpoints: Vec<usize>,
}

type CacheKey = (std::path::PathBuf, u64, Option<std::time::SystemTime>, Option<String>);

/// 直近に開いた 1 ファイル分だけ保持する
static CSV_CACHE: std::sync::Mutex<Option<(CacheKey, std::sync::Arc<ParsedCsv>)>> =
    std::sync::Mutex::new(None);

fn parse_csv_file(path: &str, delimiter: Option<String>) -> Result<std::sync::Arc<ParsedCsv>, String> {
    let size = crate::utils::assert_regular_file(std::path::Path::new(path))?;
    if size > MAX_CSV_SIZE {
        return Err(format!("CSV file too large: {} bytes (max 512 MB)", size));
    }
    let modified = fs::metadata(path).ok().and_then(|m| m.modified().ok());
    let key: CacheKey = (std::path::PathBuf::from(path), size, modified, delimiter.clone());
    if let Ok(cache) = CSV_CACHE.lock() {
        if let Some((k, parsed)) = cache.as_ref() {
            if *k == key {
                return Ok(parsed.clone());
            }
        }
    }

    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let (content, encoding) = decode_file(&raw);
    drop(raw);
    let delim = parse_delimiter(delimiter, &content);

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut checkpoints = Vec::new();
    let mut total_rows = 0usize;
    let mut max_cols = headers.len();
    let mut record = csv::StringRecord::new();
    loop {
        let start = rdr.position().byte() as usize;
        if !rdr.read_record(&mut record).map_err(|e| e.to_string())? {
            break;
        }
        if total_rows % CHECKPOINT_INTERVAL == 0 {
            checkpoints.push(start);
        }
        max_cols = max_cols.max(record.len());
        total_rows += 1;
    }

    let parsed = std::sync::Arc::new(ParsedCsv {
        content,
        encoding,
        delimiter: delim,
        headers,
        total_rows,
        max_cols,
        checkpoints,
    });
    if let Ok(mut cache) = CSV_CACHE.lock() {
        *cache = Some((key, parsed.clone()));
    }
    Ok(parsed)
}

impl ParsedCsv {
    fn reader_from(&self, byte: usize) -> csv::Reader<&[u8]> {
        csv::ReaderBuilder::new()
            .delimiter(self.delimiter)
            .has_headers(false)
            .flexible(true)
            .from_reader(&self.content.as_bytes()[byte..])
    }

    /// offset 行目から limit 行。直前のチェックポイントから読み進める。
    fn rows(&self, offset: usize, limit: usize) -> Result<Vec<Vec<String>>, String> {
        if offset >= self.total_rows || limit == 0 {
            return Ok(Vec::new());
        }
        let cp = offset / CHECKPOINT_INTERVAL;
        let mut rows: Vec<Vec<String>> = self
            .reader_from(self.checkpoints[cp])
            .records()
            .skip(offset - cp * CHECKPOINT_INTERVAL)
            .take(limit)
            .map(|r| r.map(|rec| rec.iter().map(|s| s.to_string()).collect()))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let mut headers = self.headers.clone();
        pad_columns(&mut headers, &mut rows, self.max_cols);
        Ok(rows)
    }

    fn all_rows(&self) -> Result<Vec<Vec<String>>, String> {
        self.rows(0, self.total_rows)
    }

    fn padded_headers(&self) -> Vec<String> {
        let mut headers = self.headers.clone();
        pad_columns(&mut headers, &mut [], self.max_cols);
        headers
    }

    fn data(&self, rows: Vec<Vec<String>>, total_rows: usize) -> CsvData {
        let headers = self.padded_headers();
        CsvData {
            headers: headers.clone(),
            rows,
            meta: CsvMeta {
                total_rows,
                columns: headers.len(),
                encoding: self.encoding.clone(),
                delimiter: (self.delimiter as char).to_string(),
                headers,
            },
        }
    }
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// ファイルのテキストエンコーディングを検出して返す。
#[tauri::command(async)]
pub fn detect_encoding(path: String) -> Result<String, String> {
    crate::utils::catch_panic(move || Ok(parse_csv_file(&path, None)?.encoding.clone()))
}

/// CSV ファイルを読み込む。先頭 limit 行（デフォルト 100）とメタデータを返す。
#[tauri::command(async)]
pub fn read_csv(
    path: String,
    delimiter: Option<String>,
    limit: Option<usize>,
) -> Result<CsvData, String> {
    crate::utils::catch_panic(move || {
        let parsed = parse_csv_file(&path, delimiter)?;
        let rows = parsed.rows(0, limit.unwrap_or(100))?;
        Ok(parsed.data(rows, parsed.total_rows))
    })
}

/// CSV ファイルのチャンク（offset 行目から limit 行）を返す。
#[tauri::command(async)]
pub fn read_csv_chunk(
    path: String,
    delimiter: Option<String>,
    offset: usize,
    limit: usize,
) -> Result<CsvChunk, String> {
    crate::utils::catch_panic(move || {
        let parsed = parse_csv_file(&path, delimiter)?;
        Ok(CsvChunk {
            headers: parsed.padded_headers(),
            rows: parsed.rows(offset, limit)?,
            offset,
            total_rows: parsed.total_rows,
        })
    })
}

/// フィルタ条件（AND 複合）で絞り込んだ全行を返す。
#[tauri::command(async)]
pub fn filter_csv(
    path: String,
    delimiter: Option<String>,
    conditions: Vec<FilterCondition>,
) -> Result<CsvData, String> {
    crate::utils::catch_panic(move || {
        let parsed = parse_csv_file(&path, delimiter)?;
        let rows = apply_filters(&parsed.padded_headers(), &parsed.all_rows()?, &conditions);
        let total = rows.len();
        Ok(parsed.data(rows, total))
    })
}

/// フィルタ結果を CSV ファイルとして output_path に保存する。
#[tauri::command(async)]
pub fn export_csv(
    path: String,
    delimiter: Option<String>,
    output_path: String,
    conditions: Vec<FilterCondition>,
) -> Result<(), String> {
    crate::utils::catch_panic(move || {
        let parsed = parse_csv_file(&path, delimiter)?;
        let headers = parsed.padded_headers();
        let filters = compile_filters(&headers, &conditions);

        let out_file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
        let mut wtr = csv::WriterBuilder::new()
            .delimiter(parsed.delimiter)
            .from_writer(out_file);
        wtr.write_record(&headers).map_err(|e| e.to_string())?;
        for row in parsed.all_rows()? {
            if row_matches_all(&filters, &row) {
                wtr.write_record(&row).map_err(|e| e.to_string())?;
            }
        }
        wtr.flush().map_err(|e| e.to_string())?;
        Ok(())
    })
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
    fn pad_columns_pads_short_header_and_rows() {
        let mut headers = vec!["sep=,".to_string()];
        let mut rows = vec![
            vec!["a".into(), "b".into(), "c".into()],
            vec!["d".into(), "e".into()],
        ];
        pad_columns(&mut headers, &mut rows, 3);
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

    fn temp_csv(name: &str, content: &str) -> String {
        let path = std::env::temp_dir().join(format!("qv_csv_{}_{}.csv", name, std::process::id()));
        std::fs::write(&path, content).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn chunks_across_checkpoints_return_the_right_rows() {
        let mut content = String::from("id,note\n");
        for i in 0..2_500 {
            // 改行を含む引用符付きフィールドでもレコード位置がずれないこと
            content.push_str(&format!("{i},\"line1\nline2 {i}\"\n"));
        }
        let path = temp_csv("chunks", &content);
        let chunk = read_csv_chunk(path.clone(), None, 1_999, 3).unwrap();
        let head = read_csv(path.clone(), None, Some(2)).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(chunk.total_rows, 2_500);
        let ids: Vec<&str> = chunk.rows.iter().map(|r| r[0].as_str()).collect();
        assert_eq!(ids, vec!["1999", "2000", "2001"]);
        assert_eq!(chunk.rows[1][1], "line1\nline2 2000");
        assert_eq!(head.meta.total_rows, 2_500);
        assert_eq!(head.rows.len(), 2);
    }

    #[test]
    fn columns_that_appear_after_the_first_rows_get_headers() {
        let mut content = String::from("a,b\n");
        for _ in 0..150 {
            content.push_str("1,2\n");
        }
        content.push_str("1,2,3,4\n");
        let path = temp_csv("wide", &content);
        let first = read_csv(path.clone(), None, Some(100)).unwrap();
        let tail = read_csv_chunk(path.clone(), None, 150, 10).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(first.headers, vec!["a", "b", "Column 3", "Column 4"]);
        assert!(first.rows.iter().all(|r| r.len() == 4));
        assert_eq!(tail.rows[0], vec!["1", "2", "3", "4"]);
    }

    #[test]
    fn modified_file_is_parsed_again() {
        let path = temp_csv("modified", "a\n1\n");
        assert_eq!(read_csv(path.clone(), None, None).unwrap().meta.total_rows, 1);
        std::fs::write(&path, "a\n1\n2\n3\n").unwrap();
        let after = read_csv(path.clone(), None, None).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(after.meta.total_rows, 3);
    }

    #[test]
    fn export_writes_only_matching_rows() {
        let path = temp_csv("export_src", "name,age\nAlice,30\nBob,25\nCarol,35\n");
        let out = std::env::temp_dir().join(format!("qv_csv_export_{}.csv", std::process::id()));
        let cond = FilterCondition { column: "age".into(), filter_type: "gte".into(), value: "30".into() };
        export_csv(path.clone(), None, out.to_string_lossy().into_owned(), vec![cond]).unwrap();
        let written = std::fs::read_to_string(&out).unwrap();
        std::fs::remove_file(&path).ok();
        std::fs::remove_file(&out).ok();
        assert_eq!(written, "name,age\nAlice,30\nCarol,35\n");
    }

    #[test]
    fn decode_file_utf8() {
        let data = b"hello, world";
        let (decoded, encoding) = decode_file(data);
        assert_eq!(decoded, "hello, world");
        assert!(!encoding.is_empty());
    }
}
