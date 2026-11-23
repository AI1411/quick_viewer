use chardetng::EncodingDetector;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::io::BufWriter;
use std::sync::{Arc, Mutex};

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

#[derive(Debug, Deserialize, Clone)]
pub struct FilterCondition {
    pub column: String,
    /// Prefer this over `column` name lookup when set (handles duplicate headers).
    #[serde(default)]
    pub column_index: Option<usize>,
    /// "exact" | "contains" | "starts_with" | "regex" | "gt" | "lt" | "gte" | "lte" | "eq_num"
    pub filter_type: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct CellMatch {
    pub row: usize,
    pub col: usize,
}

// ─── Index cache ──────────────────────────────────────────────────────────────

/// Row-start byte offsets into decoded UTF-8 content, plus open-file metadata.
#[derive(Debug)]
pub struct CsvIndex {
    pub path: String,
    /// Decoded file text (BOM stripped). Chunk seeks slice this by `row_offsets`.
    pub content: String,
    pub encoding: String,
    pub delimiter: u8,
    pub headers: Vec<String>,
    /// Byte offset in `content` where each data row starts, plus a sentinel at `content.len()`.
    /// Length is always `row_count + 1`.
    pub row_offsets: Vec<usize>,
}

impl CsvIndex {
    pub fn row_count(&self) -> usize {
        self.row_offsets.len().saturating_sub(1)
    }

    pub fn delim_str(&self) -> String {
        (self.delimiter as char).to_string()
    }
}

/// In-memory index cache keyed by absolute/normalized path.
pub struct CsvCache(pub Mutex<HashMap<String, Arc<CsvIndex>>>);

impl Default for CsvCache {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
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

fn pad_row(mut row: Vec<String>, cols: usize) -> Vec<String> {
    while row.len() < cols {
        row.push(String::new());
    }
    row
}

/// Build a row-offset index over decoded CSV text.
pub(crate) fn build_index_from_content(
    path: &str,
    content: String,
    encoding: String,
    delimiter: u8,
) -> Result<CsvIndex, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());

    let mut headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut row_offsets: Vec<usize> = Vec::new();
    let mut record = csv::StringRecord::new();
    let mut sample_rows: Vec<Vec<String>> = Vec::new();
    const SAMPLE_FOR_NORMALIZE: usize = 32;

    loop {
        let pos = rdr.position().byte() as usize;
        match rdr.read_record(&mut record) {
            Ok(true) => {
                row_offsets.push(pos);
                if sample_rows.len() < SAMPLE_FOR_NORMALIZE {
                    sample_rows.push(record.iter().map(|s| s.to_string()).collect());
                }
            }
            Ok(false) => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    row_offsets.push(content.len());

    normalize_columns(&mut headers, &mut sample_rows);

    Ok(CsvIndex {
        path: path.to_string(),
        content,
        encoding,
        delimiter,
        headers,
        row_offsets,
    })
}

/// Read + decode a CSV file and build its row-offset index.
pub(crate) fn build_csv_index(
    path: &str,
    delimiter: Option<String>,
) -> Result<CsvIndex, String> {
    check_csv_file(path)?;
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let (content, encoding_name) = decode_file(&raw);
    let delim = parse_delimiter(delimiter, &content);
    build_index_from_content(path, content, encoding_name, delim)
}

fn cache_key(path: &str, delimiter: Option<&str>) -> String {
    match delimiter {
        Some(d) => format!("{path}\0{d}"),
        None => format!("{path}\0auto"),
    }
}

fn get_or_build_index(
    cache: &CsvCache,
    path: &str,
    delimiter: Option<String>,
) -> Result<Arc<CsvIndex>, String> {
    let key = cache_key(path, delimiter.as_deref());
    {
        let guard = cache.0.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = guard.get(&key) {
            return Ok(Arc::clone(existing));
        }
    }
    let index = Arc::new(build_csv_index(path, delimiter)?);
    let mut guard = cache.0.lock().map_err(|e| e.to_string())?;
    guard.insert(key, Arc::clone(&index));
    Ok(index)
}

/// Parse data rows in `[offset, offset+limit)` using the byte-offset index (no full reparse).
pub(crate) fn read_rows_from_index(
    index: &CsvIndex,
    offset: usize,
    limit: usize,
) -> Result<Vec<Vec<String>>, String> {
    let total = index.row_count();
    if offset >= total || limit == 0 {
        return Ok(Vec::new());
    }
    let end = (offset + limit).min(total);
    let start_byte = index.row_offsets[offset];
    let end_byte = index.row_offsets[end];
    let slice = &index.content[start_byte..end_byte];

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(index.delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(slice.as_bytes());

    let cols = index.headers.len();
    let mut rows = Vec::with_capacity(end - offset);
    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;
        rows.push(pad_row(
            record.iter().map(|s| s.to_string()).collect(),
            cols,
        ));
    }
    Ok(rows)
}

fn read_row_at(index: &CsvIndex, row_idx: usize) -> Result<Vec<String>, String> {
    let mut rows = read_rows_from_index(index, row_idx, 1)?;
    Ok(rows.pop().unwrap_or_else(|| vec![String::new(); index.headers.len()]))
}

fn meta_from_index(index: &CsvIndex) -> CsvMeta {
    CsvMeta {
        total_rows: index.row_count(),
        columns: index.headers.len(),
        encoding: index.encoding.clone(),
        delimiter: index.delim_str(),
        headers: index.headers.clone(),
    }
}

/// Compiled filter matcher (regex compiled once per condition).
struct CompiledFilter {
    col_idx: usize,
    filter_type: String,
    value: String,
    regex: Option<Regex>,
}

fn resolve_column_index(headers: &[String], cond: &FilterCondition) -> Result<usize, String> {
    if let Some(idx) = cond.column_index {
        if idx >= headers.len() {
            return Err(format!(
                "column_index {} out of range ({} columns)",
                idx,
                headers.len()
            ));
        }
        return Ok(idx);
    }
    headers
        .iter()
        .position(|h| h == &cond.column)
        .ok_or_else(|| format!("column not found: {}", cond.column))
}

fn compile_filters(
    headers: &[String],
    conditions: &[FilterCondition],
) -> Result<Vec<CompiledFilter>, String> {
    let mut out = Vec::with_capacity(conditions.len());
    for cond in conditions {
        let col_idx = resolve_column_index(headers, cond)?;
        let regex = if cond.filter_type == "regex" {
            Some(
                Regex::new(&cond.value)
                    .map_err(|e| format!("invalid regex: {e}"))?,
            )
        } else {
            None
        };
        out.push(CompiledFilter {
            col_idx,
            filter_type: cond.filter_type.clone(),
            value: cond.value.clone(),
            regex,
        });
    }
    Ok(out)
}

fn compiled_row_matches(value: &str, filter: &CompiledFilter) -> bool {
    match filter.filter_type.as_str() {
        "exact" => value == filter.value,
        "contains" => value.contains(&filter.value),
        "starts_with" => value.starts_with(&filter.value),
        "regex" => filter
            .regex
            .as_ref()
            .map(|re| re.is_match(value))
            .unwrap_or(false),
        "gt" => parse_f64(value)
            .zip(parse_f64(&filter.value))
            .map(|(a, b)| a > b)
            .unwrap_or(false),
        "lt" => parse_f64(value)
            .zip(parse_f64(&filter.value))
            .map(|(a, b)| a < b)
            .unwrap_or(false),
        "gte" => parse_f64(value)
            .zip(parse_f64(&filter.value))
            .map(|(a, b)| a >= b)
            .unwrap_or(false),
        "lte" => parse_f64(value)
            .zip(parse_f64(&filter.value))
            .map(|(a, b)| a <= b)
            .unwrap_or(false),
        "eq_num" => parse_f64(value)
            .zip(parse_f64(&filter.value))
            .map(|(a, b)| (a - b).abs() < f64::EPSILON)
            .unwrap_or(false),
        _ => false,
    }
}

/// 1 つのフィルタ条件に対してセル値が合致するか判定する（テスト用・非コンパイル版）。
fn row_matches(value: &str, condition: &FilterCondition) -> bool {
    match compile_filters(
        &[condition.column.clone()],
        &[FilterCondition {
            column: condition.column.clone(),
            column_index: Some(0),
            filter_type: condition.filter_type.clone(),
            value: condition.value.clone(),
        }],
    ) {
        Ok(compiled) => compiled
            .first()
            .map(|f| compiled_row_matches(value, f))
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn parse_f64(s: &str) -> Option<f64> {
    s.parse::<f64>().ok()
}

/// Parse a string as a number only when the entire string is numeric
/// (mirrors frontend `tryParseEntireNumber` / `compareCellValues`).
fn try_parse_entire_number(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

/// Shared cell-value comparator for CSV column sorting.
pub(crate) fn compare_cell_values(a: &str, b: &str) -> Ordering {
    match (try_parse_entire_number(a), try_parse_entire_number(b)) {
        (Some(na), Some(nb)) => na.partial_cmp(&nb).unwrap_or(Ordering::Equal),
        _ => a.cmp(b),
    }
}

/// Sort all rows by column index. `direction` is `"asc"` or `"desc"`.
pub(crate) fn sort_rows(
    rows: &mut [Vec<String>],
    column_index: usize,
    direction: &str,
) {
    let desc = direction.eq_ignore_ascii_case("desc");
    rows.sort_by(|a, b| {
        let av = a.get(column_index).map(|s| s.as_str()).unwrap_or("");
        let bv = b.get(column_index).map(|s| s.as_str()).unwrap_or("");
        let cmp = compare_cell_values(av, bv);
        if desc { cmp.reverse() } else { cmp }
    });
}

/// Build a search regex mirroring frontend `buildRegex`.
fn build_search_regex(query: &str, use_regex: bool, case_sensitive: bool) -> Result<Option<Regex>, String> {
    if query.is_empty() {
        return Ok(None);
    }
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map(Some)
        .map_err(|e| format!("invalid regex: {e}"))
}

/// Search all cells; returns (row, col) matches in display order.
pub(crate) fn search_rows(
    rows: &[Vec<String>],
    col_count: usize,
    query: &str,
    use_regex: bool,
    case_sensitive: bool,
) -> Result<Vec<CellMatch>, String> {
    let Some(re) = build_search_regex(query, use_regex, case_sensitive)? else {
        return Ok(Vec::new());
    };
    let mut matches = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        for c in 0..col_count {
            let value = row.get(c).map(|s| s.as_str()).unwrap_or("");
            if re.is_match(value) {
                matches.push(CellMatch { row: r, col: c });
            }
        }
    }
    Ok(matches)
}

/// Collect matching source row indices (AND of conditions) without materializing all rows twice.
fn filter_row_indices(
    index: &CsvIndex,
    conditions: &[FilterCondition],
) -> Result<Vec<usize>, String> {
    if conditions.is_empty() {
        return Ok((0..index.row_count()).collect());
    }
    let compiled = compile_filters(&index.headers, conditions)?;
    let mut indices = Vec::new();
    // Stream in chunks to avoid holding every row as Vec simultaneously for huge files
    // while still using the index seeks.
    const SCAN_CHUNK: usize = 2048;
    let total = index.row_count();
    let mut offset = 0;
    while offset < total {
        let rows = read_rows_from_index(index, offset, SCAN_CHUNK)?;
        for (i, row) in rows.iter().enumerate() {
            let ok = compiled.iter().all(|f| {
                let value = row.get(f.col_idx).map(|s| s.as_str()).unwrap_or("");
                compiled_row_matches(value, f)
            });
            if ok {
                indices.push(offset + i);
            }
        }
        offset += rows.len().max(1);
        if rows.is_empty() {
            break;
        }
    }
    Ok(indices)
}

fn materialize_indices(index: &CsvIndex, indices: &[usize]) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::with_capacity(indices.len());
    for &i in indices {
        rows.push(read_row_at(index, i)?);
    }
    Ok(rows)
}

/// 複数フィルタ条件（AND）を全行に適用して合致行を返す。
pub(crate) fn apply_filters(
    headers: &[String],
    rows: &[Vec<String>],
    conditions: &[FilterCondition],
) -> Result<Vec<Vec<String>>, String> {
    if conditions.is_empty() {
        return Ok(rows.to_vec());
    }
    let compiled = compile_filters(headers, conditions)?;
    Ok(rows
        .iter()
        .filter(|row| {
            compiled.iter().all(|f| {
                let value = row.get(f.col_idx).map(|s| s.as_str()).unwrap_or("");
                compiled_row_matches(value, f)
            })
        })
        .cloned()
        .collect())
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

/// Drop a cached index for `path` (all delimiter variants).
#[tauri::command(async)]
pub fn close_csv(path: String, state: tauri::State<'_, CsvCache>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.retain(|k, _| !k.starts_with(&path));
    Ok(())
}

/// ファイルのテキストエンコーディングを検出して返す。
#[tauri::command(async)]
pub fn detect_encoding(path: String) -> Result<String, String> {
    check_csv_file(&path)?;
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let (_, encoding_name) = decode_file(&raw);
    Ok(encoding_name)
}

/// CSV ファイルを読み込む。索引を構築・キャッシュし、先頭 limit 行とメタデータを返す。
#[tauri::command(async)]
pub fn read_csv(
    path: String,
    delimiter: Option<String>,
    limit: Option<usize>,
    state: tauri::State<'_, CsvCache>,
) -> Result<CsvData, String> {
    let index = get_or_build_index(&state, &path, delimiter)?;
    let max_rows = limit.unwrap_or(100);
    let rows = read_rows_from_index(&index, 0, max_rows)?;

    Ok(CsvData {
        headers: index.headers.clone(),
        rows,
        meta: meta_from_index(&index),
    })
}

/// CSV ファイルのチャンク（offset 行目から limit 行）を索引シークで返す。
#[tauri::command(async)]
pub fn read_csv_chunk(
    path: String,
    delimiter: Option<String>,
    offset: usize,
    limit: usize,
    state: tauri::State<'_, CsvCache>,
) -> Result<CsvChunk, String> {
    let index = get_or_build_index(&state, &path, delimiter)?;
    let rows = read_rows_from_index(&index, offset, limit)?;

    Ok(CsvChunk {
        headers: index.headers.clone(),
        rows,
        offset,
        total_rows: index.row_count(),
    })
}

/// フィルタ条件（AND 複合）で絞り込んだ全行を返す（索引キャッシュを利用）。
#[tauri::command(async)]
pub fn filter_csv(
    path: String,
    delimiter: Option<String>,
    conditions: Vec<FilterCondition>,
    state: tauri::State<'_, CsvCache>,
) -> Result<CsvData, String> {
    let index = get_or_build_index(&state, &path, delimiter)?;
    let indices = filter_row_indices(&index, &conditions)?;
    let filtered = materialize_indices(&index, &indices)?;
    let total_rows = filtered.len();

    Ok(CsvData {
        headers: index.headers.clone(),
        rows: filtered,
        meta: CsvMeta {
            total_rows,
            columns: index.headers.len(),
            encoding: index.encoding.clone(),
            delimiter: index.delim_str(),
            headers: index.headers.clone(),
        },
    })
}

/// Sort all CSV rows by column index (full file via index). `ascending` true = asc.
#[tauri::command(async)]
pub fn sort_csv(
    path: String,
    delimiter: Option<String>,
    column_index: usize,
    ascending: bool,
    conditions: Option<Vec<FilterCondition>>,
    state: tauri::State<'_, CsvCache>,
) -> Result<CsvData, String> {
    let index = get_or_build_index(&state, &path, delimiter)?;

    if column_index >= index.headers.len() {
        return Err(format!(
            "column_index {} out of range ({} columns)",
            column_index,
            index.headers.len()
        ));
    }

    let conds = conditions.unwrap_or_default();
    let indices = filter_row_indices(&index, &conds)?;
    let mut rows = materialize_indices(&index, &indices)?;

    let direction = if ascending { "asc" } else { "desc" };
    sort_rows(&mut rows, column_index, direction);

    let total_rows = rows.len();
    Ok(CsvData {
        headers: index.headers.clone(),
        rows,
        meta: CsvMeta {
            total_rows,
            columns: index.headers.len(),
            encoding: index.encoding.clone(),
            delimiter: index.delim_str(),
            headers: index.headers.clone(),
        },
    })
}

/// Search the whole CSV file; returns cell match indices into the (optionally filtered/sorted) row set.
#[tauri::command(async)]
pub fn search_csv(
    path: String,
    delimiter: Option<String>,
    query: String,
    use_regex: Option<bool>,
    case_sensitive: Option<bool>,
    conditions: Option<Vec<FilterCondition>>,
    sort_column_index: Option<usize>,
    sort_ascending: Option<bool>,
    state: tauri::State<'_, CsvCache>,
) -> Result<Vec<CellMatch>, String> {
    let index = get_or_build_index(&state, &path, delimiter)?;

    let conds = conditions.unwrap_or_default();
    let indices = filter_row_indices(&index, &conds)?;
    let mut rows = materialize_indices(&index, &indices)?;

    if let Some(col) = sort_column_index {
        if col >= index.headers.len() {
            return Err(format!(
                "sort_column_index {} out of range ({} columns)",
                col,
                index.headers.len()
            ));
        }
        let ascending = sort_ascending.unwrap_or(true);
        let direction = if ascending { "asc" } else { "desc" };
        sort_rows(&mut rows, col, direction);
    }

    search_rows(
        &rows,
        index.headers.len(),
        &query,
        use_regex.unwrap_or(false),
        case_sensitive.unwrap_or(false),
    )
}

/// フィルタ結果を CSV ファイルとして output_path にストリーミング保存する。
#[tauri::command(async)]
pub fn export_csv(
    path: String,
    delimiter: Option<String>,
    output_path: String,
    conditions: Vec<FilterCondition>,
    state: tauri::State<'_, CsvCache>,
) -> Result<(), String> {
    let index = get_or_build_index(&state, &path, delimiter)?;
    let compiled = if conditions.is_empty() {
        None
    } else {
        Some(compile_filters(&index.headers, &conditions)?)
    };

    let out_file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut wtr = csv::WriterBuilder::new()
        .delimiter(index.delimiter)
        .from_writer(BufWriter::new(out_file));

    wtr.write_record(&index.headers).map_err(|e| e.to_string())?;

    const SCAN_CHUNK: usize = 2048;
    let total = index.row_count();
    let mut offset = 0;
    while offset < total {
        let rows = read_rows_from_index(&index, offset, SCAN_CHUNK)?;
        if rows.is_empty() {
            break;
        }
        for row in &rows {
            let keep = match &compiled {
                None => true,
                Some(filters) => filters.iter().all(|f| {
                    let value = row.get(f.col_idx).map(|s| s.as_str()).unwrap_or("");
                    compiled_row_matches(value, f)
                }),
            };
            if keep {
                wtr.write_record(row).map_err(|e| e.to_string())?;
            }
        }
        offset += rows.len();
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::SHIFT_JIS;

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
            column_index: None,
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
            column_index: None,
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
            column_index: None,
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
            column_index: None,
            filter_type: "regex".into(),
            value: "^T.*o$".into(),
        };
        assert!(row_matches("Tokyo", &cond));
        assert!(!row_matches("Osaka", &cond));
    }

    #[test]
    fn invalid_regex_returns_error() {
        let headers = vec!["c".to_string()];
        let cond = FilterCondition {
            column: "c".into(),
            column_index: Some(0),
            filter_type: "regex".into(),
            value: "(".into(),
        };
        let err = apply_filters(&headers, &[vec!["x".into()]], &[cond]).unwrap_err();
        assert!(err.contains("invalid regex"));
    }

    #[test]
    fn filter_by_column_index_not_name() {
        // Duplicate header names: column_index picks the second "city"
        let headers = vec!["city".into(), "city".into()];
        let rows = vec![
            vec!["Tokyo".into(), "Osaka".into()],
            vec!["Kyoto".into(), "Nagoya".into()],
        ];
        let cond = FilterCondition {
            column: "city".into(),
            column_index: Some(1),
            filter_type: "exact".into(),
            value: "Osaka".into(),
        };
        let result = apply_filters(&headers, &rows, &[cond]).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0][1], "Osaka");
    }

    #[test]
    fn row_matches_gt() {
        let cond = FilterCondition {
            column: "a".into(),
            column_index: None,
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
            column_index: None,
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
            column_index: None,
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
            column_index: None,
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
                column_index: None,
                filter_type: "exact".into(),
                value: "Tokyo".into(),
            },
            FilterCondition {
                column: "age".into(),
                column_index: None,
                filter_type: "gt".into(),
                value: "28".into(),
            },
        ];
        let result = apply_filters(&headers, &rows, &conditions).unwrap();
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
        let result = apply_filters(&headers, &rows, &[]).unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn decode_file_utf8() {
        let data = b"hello, world";
        let (decoded, encoding) = decode_file(data);
        assert_eq!(decoded, "hello, world");
        assert!(!encoding.is_empty());
    }

    #[test]
    fn compare_cell_values_numeric_and_text() {
        assert_eq!(compare_cell_values("1.25", "1.5"), Ordering::Less);
        assert_eq!(compare_cell_values("-10", "-5"), Ordering::Less);
        assert_eq!(compare_cell_values("apple", "banana"), Ordering::Less);
        assert_eq!(
            compare_cell_values("2024-01-05", "2024-03-01"),
            Ordering::Less
        );
    }

    #[test]
    fn sort_rows_ascending_numeric() {
        let mut rows = vec![
            vec!["b".into(), "10".into()],
            vec!["a".into(), "2".into()],
            vec!["c".into(), "1.5".into()],
        ];
        sort_rows(&mut rows, 1, "asc");
        assert_eq!(rows[0][1], "1.5");
        assert_eq!(rows[1][1], "2");
        assert_eq!(rows[2][1], "10");
    }

    #[test]
    fn sort_rows_descending() {
        let mut rows = vec![
            vec!["Alice".into()],
            vec!["Carol".into()],
            vec!["Bob".into()],
        ];
        sort_rows(&mut rows, 0, "desc");
        assert_eq!(rows[0][0], "Carol");
        assert_eq!(rows[1][0], "Bob");
        assert_eq!(rows[2][0], "Alice");
    }

    #[test]
    fn search_rows_literal_case_insensitive() {
        let rows = vec![
            vec!["Alice".into(), "Tokyo".into()],
            vec!["Bob".into(), "Osaka".into()],
            vec!["Carol".into(), "tokyo".into()],
        ];
        let matches = search_rows(&rows, 2, "tokyo", false, false).unwrap();
        assert_eq!(
            matches,
            vec![
                CellMatch { row: 0, col: 1 },
                CellMatch { row: 2, col: 1 },
            ]
        );
    }

    #[test]
    fn search_rows_regex_case_sensitive() {
        let rows = vec![
            vec!["Alice".into()],
            vec!["alice".into()],
            vec!["ALICE".into()],
        ];
        let matches = search_rows(&rows, 1, "^Alice$", true, true).unwrap();
        assert_eq!(matches, vec![CellMatch { row: 0, col: 0 }]);
    }

    #[test]
    fn index_and_chunk_basic() {
        let index = build_index_from_content(
            "mem.csv",
            SAMPLE_CSV.to_string(),
            "UTF-8".into(),
            b',',
        )
        .unwrap();
        assert_eq!(index.row_count(), 3);
        assert_eq!(index.headers, vec!["name", "age", "city"]);

        let chunk0 = read_rows_from_index(&index, 0, 2).unwrap();
        assert_eq!(chunk0.len(), 2);
        assert_eq!(chunk0[0][0], "Alice");
        assert_eq!(chunk0[1][0], "Bob");

        let chunk1 = read_rows_from_index(&index, 2, 10).unwrap();
        assert_eq!(chunk1.len(), 1);
        assert_eq!(chunk1[0][0], "Carol");

        // Jump to last row without reading earlier rows via skip
        let last = read_rows_from_index(&index, 2, 1).unwrap();
        assert_eq!(last[0], vec!["Carol", "35", "Tokyo"]);
    }

    #[test]
    fn index_handles_utf8_bom() {
        let mut raw = vec![0xef, 0xbb, 0xbf];
        raw.extend_from_slice(SAMPLE_CSV.as_bytes());
        let (content, enc) = decode_file(&raw);
        let index = build_index_from_content("bom.csv", content, enc, b',').unwrap();
        assert_eq!(index.row_count(), 3);
        assert_eq!(index.headers[0], "name");
        let rows = read_rows_from_index(&index, 0, 1).unwrap();
        assert_eq!(rows[0][0], "Alice");
    }

    #[test]
    fn index_handles_quoted_newlines() {
        let csv = "id,note\n1,\"hello\nworld\"\n2,plain\n";
        let index =
            build_index_from_content("q.csv", csv.to_string(), "UTF-8".into(), b',').unwrap();
        assert_eq!(index.row_count(), 2);
        let row0 = read_rows_from_index(&index, 0, 1).unwrap();
        assert_eq!(row0[0][1], "hello\nworld");
        let row1 = read_rows_from_index(&index, 1, 1).unwrap();
        assert_eq!(row1[0][0], "2");
        assert_eq!(row1[0][1], "plain");
    }

    #[test]
    fn index_handles_shift_jis() {
        let unicode = "名前,値\n太郎,1\n次郎,2\n";
        let (encoded, _, _) = SHIFT_JIS.encode(unicode);
        let (content, enc) = decode_file(&encoded);
        assert!(
            enc.eq_ignore_ascii_case("Shift_JIS")
                || enc.to_ascii_lowercase().contains("windows-31j")
                || content.contains("太郎"),
            "expected Shift_JIS-ish decode, got encoding={enc} content={content:?}"
        );
        let index = build_index_from_content("sjis.csv", content, enc, b',').unwrap();
        assert_eq!(index.row_count(), 2);
        let rows = read_rows_from_index(&index, 1, 1).unwrap();
        assert_eq!(rows[0][0], "次郎");
        assert_eq!(rows[0][1], "2");
    }
}
