use regex::Regex;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::utils::{atomic_write, atomic_write_with, catch_panic, decode_file, require_extension};

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
    /// 絞り込み・並べ替えの結果で、各行が元ファイルの何行目 (0 始まりのデータ行) か
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_rows: Option<Vec<usize>>,
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
    /// 元ファイルが UTF-8 の BOM 付きか (エクスポートで引き継ぐ)
    pub has_bom: bool,
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

/// 索引を作ったときのファイルのサイズと更新日時
type FileStamp = (u64, Option<SystemTime>);

/// In-memory index cache keyed by absolute/normalized path.
pub struct CsvCache(pub Mutex<HashMap<String, (FileStamp, Arc<CsvIndex>)>>);

impl Default for CsvCache {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

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
            sample_lines
                .iter()
                .map(|line| count_unquoted(line, *c))
                .sum::<usize>()
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
    // 列数は先頭の数行ではなくファイル全体で数える (途中から列が増える行にもヘッダを付ける)
    let mut widest_row = 0usize;

    loop {
        let pos = rdr.position().byte() as usize;
        match rdr.read_record(&mut record) {
            Ok(true) => {
                row_offsets.push(pos);
                widest_row = widest_row.max(record.len());
            }
            Ok(false) => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    row_offsets.push(content.len());

    normalize_columns(&mut headers, &mut [vec![String::new(); widest_row]]);

    Ok(CsvIndex {
        path: path.to_string(),
        content,
        encoding,
        has_bom: false,
        delimiter,
        headers,
        row_offsets,
    })
}

/// Read + decode a CSV file and build its row-offset index.
pub(crate) fn build_csv_index(path: &str, delimiter: Option<String>) -> Result<CsvIndex, String> {
    check_csv_file(path)?;
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let has_bom = raw.starts_with(UTF8_BOM);
    let (content, encoding_name) = decode_file(&raw);
    let delim = parse_delimiter(delimiter, &content);
    let mut index = build_index_from_content(path, content, encoding_name, delim)?;
    index.has_bom = has_bom;
    Ok(index)
}

fn file_stamp(path: &str) -> Result<FileStamp, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok((meta.len(), meta.modified().ok()))
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
    // タブを閉じるまで索引は残るので、再読み込みで古い内容を返さないよう、
    // 索引を作った後にファイルが変わっていたら作り直す
    let stamp = file_stamp(path)?;
    {
        let guard = cache.0.lock().map_err(|e| e.to_string())?;
        if let Some((cached_stamp, existing)) = guard.get(&key) {
            if *cached_stamp == stamp {
                return Ok(Arc::clone(existing));
            }
        }
    }
    let index = Arc::new(build_csv_index(path, delimiter)?);
    let mut guard = cache.0.lock().map_err(|e| e.to_string())?;
    guard.insert(key, (stamp, Arc::clone(&index)));
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
    Ok(rows
        .pop()
        .unwrap_or_else(|| vec![String::new(); index.headers.len()]))
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
pub(crate) struct CompiledFilter {
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

pub(crate) fn compile_filters(
    headers: &[String],
    conditions: &[FilterCondition],
) -> Result<Vec<CompiledFilter>, String> {
    let mut out = Vec::with_capacity(conditions.len());
    for cond in conditions {
        let col_idx = resolve_column_index(headers, cond)?;
        let regex = if cond.filter_type == "regex" {
            Some(Regex::new(&cond.value).map_err(|e| format!("invalid regex: {e}"))?)
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

/// 1 行が全フィルタ条件（AND）に合致するか判定する。
pub(crate) fn row_matches_all(filters: &[CompiledFilter], row: &[String]) -> bool {
    filters.iter().all(|f| {
        let value = row.get(f.col_idx).map(|s| s.as_str()).unwrap_or("");
        compiled_row_matches(value, f)
    })
}

/// 1 つのフィルタ条件に対してセル値が合致するか判定する（テスト用・非コンパイル版）。
#[cfg(test)]
fn row_matches(value: &str, condition: &FilterCondition) -> bool {
    match compile_filters(
        std::slice::from_ref(&condition.column),
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
fn count_digits(bytes: &[u8]) -> usize {
    bytes.iter().take_while(|b| b.is_ascii_digit()).count()
}

/// `[-+]?(数字[.数字] | .数字)(e[-+]?数字)?` の形かどうか。
/// f64 の parse は "inf" や "nan" も数値として読むので、先に形を確かめる。
fn is_number_shape(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let int_digits = count_digits(&bytes[i..]);
    i += int_digits;
    let mut frac_digits = 0;
    if bytes.get(i) == Some(&b'.') {
        frac_digits = count_digits(&bytes[i + 1..]);
        i += 1 + frac_digits;
    }
    if int_digits + frac_digits == 0 {
        return false;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        i += usize::from(matches!(bytes.get(i), Some(b'+' | b'-')));
        let exp_digits = count_digits(&bytes[i..]);
        if exp_digits == 0 {
            return false;
        }
        i += exp_digits;
    }
    i == bytes.len()
}

/// セルの文字列を数値として読む。"1,234" "¥1,200" "12%" "1e3" に対応し、数値でなければ None。
/// "2024-03-01" や "10px" のように一部だけが数字のものは数値にしない。
///
/// フロントの tryParseEntireNumber と同じ規則 (tests/fixtures/sort-cases.json で両方を検査する)。
fn try_parse_entire_number(s: &str) -> Option<f64> {
    let s = s.trim();
    let s = s.strip_prefix(['¥', '$', '€', '£']).unwrap_or(s);
    // 並べ替えは比較のたびにここを通る。桁区切りが無い普通の数値では文字列を作り直さない
    let without_separators;
    let s = if s.contains(',') {
        without_separators = s.replace(',', "");
        without_separators.as_str()
    } else {
        s
    };
    let s = s.strip_suffix('%').unwrap_or(s);
    if !is_number_shape(s) {
        return None;
    }
    s.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// 並べ替えのキー。行ごとに 1 回だけ作り、比較のたびにセルを数値として読み直さない
/// (100 万行の並べ替えでは比較が約 2000 万回になる)。
enum SortKey<'a> {
    Number(f64),
    Text(&'a str),
    Empty,
}

impl<'a> SortKey<'a> {
    fn of(cell: &'a str) -> Self {
        if cell.is_empty() {
            SortKey::Empty
        } else if let Some(n) = try_parse_entire_number(cell) {
            SortKey::Number(n)
        } else {
            SortKey::Text(cell)
        }
    }
}

/// 数値はすべて文字列より前に置き、空のセルは昇順でも降順でも末尾に置く。
///
/// 数値と文字列を文字列として比べると、2 < 10 < "1x" < 2 のように順序が循環して
/// sort_by が panic する。種類ごとに分けて全順序にする。
fn compare_keys(a: &SortKey, b: &SortKey, desc: bool) -> Ordering {
    let cmp = match (a, b) {
        (SortKey::Empty, SortKey::Empty) => return Ordering::Equal,
        (SortKey::Empty, _) => return Ordering::Greater,
        (_, SortKey::Empty) => return Ordering::Less,
        (SortKey::Number(x), SortKey::Number(y)) => x.total_cmp(y),
        (SortKey::Number(_), SortKey::Text(_)) => Ordering::Less,
        (SortKey::Text(_), SortKey::Number(_)) => Ordering::Greater,
        (SortKey::Text(x), SortKey::Text(y)) => x.cmp(y),
    };
    if desc {
        cmp.reverse()
    } else {
        cmp
    }
}

/// Shared cell-value comparator for CSV column sorting (ascending).
#[cfg(test)]
pub(crate) fn compare_cell_values(a: &str, b: &str) -> Ordering {
    compare_keys(&SortKey::of(a), &SortKey::of(b), false)
}

/// rows を column_index の列で安定に並べ替えたときの順序を、元の位置の列で返す。
/// sort_csv と search_csv は同じ順序を使うので、検索結果の行位置は並べ替え後の表示と一致する。
fn sorted_order(rows: &[Vec<String>], column_index: usize, desc: bool) -> Vec<usize> {
    let keys: Vec<SortKey> = rows
        .iter()
        .map(|row| SortKey::of(row.get(column_index).map_or("", String::as_str)))
        .collect();
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|&a, &b| compare_keys(&keys[a], &keys[b], desc));
    order
}

/// Sort all rows by column index. `direction` is `"asc"` or `"desc"`.
pub(crate) fn sort_rows(rows: &mut [Vec<String>], column_index: usize, direction: &str) {
    let desc = direction.eq_ignore_ascii_case("desc");
    let order = sorted_order(rows, column_index, desc);
    let sorted: Vec<Vec<String>> = order
        .into_iter()
        .map(|i| std::mem::take(&mut rows[i]))
        .collect();
    for (slot, row) in rows.iter_mut().zip(sorted) {
        *slot = row;
    }
}

/// Build a search regex mirroring frontend `buildRegex`.
fn build_search_regex(
    query: &str,
    use_regex: bool,
    case_sensitive: bool,
) -> Result<Option<Regex>, String> {
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
            if row_matches_all(&compiled, row) {
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
#[cfg(test)]
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
        .filter(|row| row_matches_all(&compiled, row))
        .cloned()
        .collect())
}

// ─── エクスポート ─────────────────────────────────────────────────────────────

pub(crate) const CSV_EXTENSIONS: &[&str] = &["csv", "tsv"];

const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

/// エクスポートする CSV のバイト表現
pub(crate) struct ExportEncoding {
    pub encoding: &'static encoding_rs::Encoding,
    pub bom: bool,
}

impl ExportEncoding {
    /// Excel で文字化けしない BOM 付き UTF-8
    pub(crate) const EXCEL_UTF8: ExportEncoding = ExportEncoding {
        encoding: encoding_rs::UTF_8,
        bom: true,
    };
}

/// エクスポート先は .csv / .tsv に限り、一時ファイルに書いてから置き換える
/// (書き込み途中で失敗しても既存のファイルを壊さない)。
pub(crate) fn write_csv_export(
    output_path: &str,
    delimiter: u8,
    encoding: &ExportEncoding,
    write: impl FnOnce(&mut csv::Writer<&mut dyn Write>) -> Result<(), String>,
) -> Result<(), String> {
    let path = Path::new(output_path);
    require_extension(path, CSV_EXTENSIONS)?;
    let write_csv = |out: &mut dyn Write| -> Result<(), String> {
        let mut wtr = csv::WriterBuilder::new()
            .delimiter(delimiter)
            .from_writer(out);
        write(&mut wtr)?;
        wtr.flush().map_err(|e| e.to_string())
    };

    if encoding.encoding == encoding_rs::UTF_8 {
        // UTF-8 は変換が要らないので、行をメモリに溜めずにファイルへ流す
        return atomic_write_with(path, |file| {
            let mut out = BufWriter::new(file);
            if encoding.bom {
                out.write_all(UTF8_BOM)?;
            }
            write_csv(&mut out).map_err(std::io::Error::other)?;
            out.flush()
        })
        .map_err(|e| e.to_string());
    }

    let mut utf8 = Vec::new();
    write_csv(&mut utf8)?;
    let text = String::from_utf8(utf8).map_err(|e| e.to_string())?;
    let (bytes, _, had_errors) = encoding.encoding.encode(&text);
    if had_errors {
        return Err(format!(
            "{} で表せない文字が含まれています",
            encoding.encoding.name()
        ));
    }
    atomic_write(path, &bytes).map_err(|e| e.to_string())
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

const MAX_CSV_SIZE: u64 = 512 * 1024 * 1024; // 512 MB

fn check_csv_file(path: &str) -> Result<(), String> {
    require_extension(Path::new(path), CSV_EXTENSIONS)?;
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
    catch_panic(|| {
        check_csv_file(&path)?;
        let raw = fs::read(&path).map_err(|e| e.to_string())?;
        let (_, encoding_name) = decode_file(&raw);
        Ok(encoding_name)
    })
}

/// CSV ファイルを読み込む。索引を構築・キャッシュし、先頭 limit 行とメタデータを返す。
#[tauri::command(async)]
pub fn read_csv(
    path: String,
    delimiter: Option<String>,
    limit: Option<usize>,
    state: tauri::State<'_, CsvCache>,
) -> Result<CsvData, String> {
    catch_panic(|| {
        let index = get_or_build_index(&state, &path, delimiter)?;
        let max_rows = limit.unwrap_or(100);
        let rows = read_rows_from_index(&index, 0, max_rows)?;

        Ok(CsvData {
            headers: index.headers.clone(),
            rows,
            meta: meta_from_index(&index),
            source_rows: None,
        })
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
    catch_panic(|| {
        let index = get_or_build_index(&state, &path, delimiter)?;
        let rows = read_rows_from_index(&index, offset, limit)?;

        Ok(CsvChunk {
            headers: index.headers.clone(),
            rows,
            offset,
            total_rows: index.row_count(),
        })
    })
}

fn filter_index(index: &CsvIndex, conditions: &[FilterCondition]) -> Result<CsvData, String> {
    let indices = filter_row_indices(index, conditions)?;
    let filtered = materialize_indices(index, &indices)?;
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
        // 条件が無ければ全行が元の順のままなので、行番号は送らない
        source_rows: (!conditions.is_empty()).then_some(indices),
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
    catch_panic(|| {
        let index = get_or_build_index(&state, &path, delimiter)?;
        filter_index(&index, &conditions)
    })
}

fn sort_index(
    index: &CsvIndex,
    column_index: usize,
    ascending: bool,
    conditions: &[FilterCondition],
) -> Result<CsvData, String> {
    if column_index >= index.headers.len() {
        return Err(format!(
            "column_index {} out of range ({} columns)",
            column_index,
            index.headers.len()
        ));
    }

    let indices = filter_row_indices(index, conditions)?;
    let mut rows = materialize_indices(index, &indices)?;

    // 並べ替えた順に、行と元の行番号を並べ直す。search_csv の sort_rows と同じ順序なので、
    // 検索結果の行位置はこの並び順と一致する
    let order = sorted_order(&rows, column_index, !ascending);
    let source_rows: Vec<usize> = order.iter().map(|&i| indices[i]).collect();
    let rows: Vec<Vec<String>> = order
        .into_iter()
        .map(|i| std::mem::take(&mut rows[i]))
        .collect();

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
        source_rows: Some(source_rows),
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
    catch_panic(|| {
        let index = get_or_build_index(&state, &path, delimiter)?;
        sort_index(
            &index,
            column_index,
            ascending,
            &conditions.unwrap_or_default(),
        )
    })
}

/// Search the whole CSV file; returns cell match indices into the (optionally filtered/sorted) row set.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
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
    catch_panic(|| {
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
    })
}

/// 条件に合う行を、元ファイルと同じ文字コード・BOM の有無で書き出す。
fn export_index(
    index: &CsvIndex,
    output_path: &str,
    conditions: &[FilterCondition],
) -> Result<(), String> {
    let compiled = compile_filters(&index.headers, conditions)?;
    let encoding = ExportEncoding {
        encoding: encoding_rs::Encoding::for_label(index.encoding.as_bytes())
            .unwrap_or(encoding_rs::UTF_8),
        bom: index.has_bom,
    };

    write_csv_export(output_path, index.delimiter, &encoding, |wtr| {
        wtr.write_record(&index.headers)
            .map_err(|e| e.to_string())?;

        const SCAN_CHUNK: usize = 2048;
        let total = index.row_count();
        let mut offset = 0;
        while offset < total {
            let rows = read_rows_from_index(index, offset, SCAN_CHUNK)?;
            if rows.is_empty() {
                break;
            }
            for row in rows.iter().filter(|row| row_matches_all(&compiled, row)) {
                wtr.write_record(row).map_err(|e| e.to_string())?;
            }
            offset += rows.len();
        }
        Ok(())
    })
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
    catch_panic(|| {
        let index = get_or_build_index(&state, &path, delimiter)?;
        export_index(&index, &output_path, &conditions)
    })
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
        let rows = vec![vec!["Alice".to_string()], vec!["Bob".to_string()]];
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

    /// 数値と文字列が混ざった列でも並べ替えられる。
    /// 比較が全順序でないと (2 < 10 < "1x" < 2 のように循環すると) sort_by が panic する。
    #[test]
    fn sorting_a_column_that_mixes_numbers_and_text_does_not_panic() {
        let values = [
            "2", "10", "1x", "", "-3", "abc", "1,234", "7.5", "NaN", "inf", "3", "20", "2x", "1",
        ];
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..500 {
            let len = 2 + (next() % 120) as usize;
            let mut rows: Vec<Vec<String>> = (0..len)
                .map(|_| vec![values[(next() % values.len() as u64) as usize].to_string()])
                .collect();
            sort_rows(&mut rows, 0, if round % 2 == 0 { "asc" } else { "desc" });
            assert_eq!(rows.len(), len);
        }
    }

    #[derive(serde::Deserialize)]
    struct SortCases {
        numbers: Vec<(String, Option<f64>)>,
        sorts: Vec<SortCase>,
    }

    #[derive(serde::Deserialize)]
    struct SortCase {
        name: String,
        input: Vec<String>,
        asc: Vec<String>,
        desc: Vec<String>,
    }

    /// フロント (compareCellValues.ts) も同じ sort-cases.json を読む。
    /// CSV は Rust、XLSX はフロントで並べ替えるので、規則を揃える。
    #[test]
    fn sorting_follows_the_rules_shared_with_the_frontend() {
        let cases: SortCases =
            serde_json::from_str(include_str!("../tests/fixtures/sort-cases.json")).unwrap();

        for (text, expected) in &cases.numbers {
            assert_eq!(try_parse_entire_number(text), *expected, "{text:?}");
        }
        for case in &cases.sorts {
            for (direction, expected) in [("asc", &case.asc), ("desc", &case.desc)] {
                let mut rows: Vec<Vec<String>> =
                    case.input.iter().map(|v| vec![v.clone()]).collect();
                sort_rows(&mut rows, 0, direction);
                let sorted: Vec<&String> = rows.iter().map(|r| &r[0]).collect();
                assert_eq!(
                    sorted,
                    expected.iter().collect::<Vec<_>>(),
                    "{} ({direction})",
                    case.name
                );
            }
        }
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
            vec![CellMatch { row: 0, col: 1 }, CellMatch { row: 2, col: 1 },]
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
        let index =
            build_index_from_content("mem.csv", SAMPLE_CSV.to_string(), "UTF-8".into(), b',')
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

    fn temp_path(name: &str, ext: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("qv_csv_{}_{}.{}", name, std::process::id(), ext))
    }

    fn temp_csv(name: &str, content: &str) -> String {
        let path = temp_path(name, "csv");
        std::fs::write(&path, content).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn condition(column: &str, filter_type: &str, value: &str) -> FilterCondition {
        FilterCondition {
            column: column.into(),
            column_index: None,
            filter_type: filter_type.into(),
            value: value.into(),
        }
    }

    #[test]
    fn columns_that_appear_after_the_first_rows_get_headers() {
        let mut content = String::from("a,b\n");
        for _ in 0..150 {
            content.push_str("1,2\n");
        }
        content.push_str("1,2,3,4\n");
        let index = build_index_from_content("wide.csv", content, "UTF-8".into(), b',').unwrap();
        let first = read_rows_from_index(&index, 0, 100).unwrap();
        let tail = read_rows_from_index(&index, 150, 10).unwrap();
        assert_eq!(index.headers, vec!["a", "b", "Column 3", "Column 4"]);
        assert!(first.iter().all(|r| r.len() == 4));
        assert_eq!(tail[0], vec!["1", "2", "3", "4"]);
    }

    #[test]
    fn modified_file_is_parsed_again() {
        let path = temp_csv("modified", "a\n1\n");
        let cache = CsvCache::default();
        let before = get_or_build_index(&cache, &path, None).unwrap();
        let unchanged = get_or_build_index(&cache, &path, None).unwrap();
        std::fs::write(&path, "a\n1\n2\n3\n").unwrap();
        let after = get_or_build_index(&cache, &path, None).unwrap();
        std::fs::remove_file(&path).ok();
        assert!(Arc::ptr_eq(&before, &unchanged));
        assert_eq!((before.row_count(), after.row_count()), (1, 3));
    }

    #[test]
    fn export_writes_only_matching_rows() {
        let path = temp_csv("export_src", "name,age\nAlice,30\nBob,25\nCarol,35\n");
        let out = temp_path("export_out", "csv");
        let index = build_csv_index(&path, None).unwrap();
        export_index(
            &index,
            &out.to_string_lossy(),
            &[condition("age", "gte", "30")],
        )
        .unwrap();
        let written = std::fs::read_to_string(&out).unwrap();
        std::fs::remove_file(&path).ok();
        std::fs::remove_file(&out).ok();
        assert_eq!(written, "name,age\nAlice,30\nCarol,35\n");
    }

    #[test]
    fn export_keeps_the_source_encoding_and_bom() {
        let out = temp_path("enc_out", "csv");
        let out_s = out.to_string_lossy().into_owned();

        let (sjis, _, _) = SHIFT_JIS.encode("名前,都市\n山田,東京\n佐藤,大阪\n");
        let sjis_src = temp_path("sjis_src", "csv");
        std::fs::write(&sjis_src, &sjis).unwrap();
        let sjis_index = build_csv_index(&sjis_src.to_string_lossy(), None).unwrap();
        export_index(&sjis_index, &out_s, &[]).unwrap();
        let sjis_out = std::fs::read(&out).unwrap();

        let bom_src = temp_csv("bom_src", "\u{FEFF}a,b\n1,2\n");
        let bom_index = build_csv_index(&bom_src, None).unwrap();
        export_index(&bom_index, &out_s, &[]).unwrap();
        let bom_out = std::fs::read(&out).unwrap();

        std::fs::remove_file(&sjis_src).ok();
        std::fs::remove_file(&bom_src).ok();
        std::fs::remove_file(&out).ok();
        assert_eq!(sjis_out, sjis.into_owned());
        assert!(bom_out.starts_with(UTF8_BOM));
        assert_eq!(&bom_out[3..], b"a,b\n1,2\n");
    }

    #[test]
    fn export_fails_when_the_source_encoding_cannot_represent_a_cell() {
        let index = CsvIndex {
            encoding: "Shift_JIS".into(),
            ..build_index_from_content("emoji.csv", "a\n😀\n".into(), "UTF-8".into(), b',').unwrap()
        };
        let out = temp_path("unmappable_out", "csv");
        let result = export_index(&index, &out.to_string_lossy(), &[]);
        let wrote = out.exists();
        std::fs::remove_file(&out).ok();
        assert!(result.is_err());
        assert!(!wrote);
    }

    #[test]
    fn csv_commands_reject_other_file_types() {
        let secret = temp_path("guard", "key");
        std::fs::write(&secret, "a,b\n1,2\n").unwrap();
        let src = temp_csv("guard_src", "a\n1\n");
        let read = get_or_build_index(&CsvCache::default(), &secret.to_string_lossy(), None);
        let out = temp_path("guard_out", "plist");
        let export = export_index(
            &build_csv_index(&src, None).unwrap(),
            &out.to_string_lossy(),
            &[],
        );
        let wrote = out.exists();
        std::fs::remove_file(&secret).ok();
        std::fs::remove_file(&src).ok();
        assert!(read.is_err());
        assert!(export.is_err());
        assert!(!wrote);
    }

    #[test]
    fn filter_reports_source_row_numbers() {
        let csv = "name,age\nAlice,30\nBob,25\nCarol,35\n";
        let index = build_index_from_content("f.csv", csv.into(), "UTF-8".into(), b',').unwrap();
        let filtered = filter_index(&index, &[condition("age", "gt", "28")]).unwrap();
        let unfiltered = filter_index(&index, &[]).unwrap();
        assert_eq!(filtered.source_rows, Some(vec![0, 2]));
        assert_eq!(filtered.rows.len(), 2);
        assert_eq!(unfiltered.source_rows, None);
        assert_eq!(unfiltered.rows.len(), 3);
    }

    #[test]
    fn sort_reports_source_row_numbers_in_the_order_search_uses() {
        // age が同じ行 (Bob と Dave) の順序も含めて、search_csv が使う sort_rows と一致すること
        let csv = "name,age\nAlice,30\nBob,25\nCarol,35\nDave,25\nEve,9\n";
        let index = build_index_from_content("s.csv", csv.into(), "UTF-8".into(), b',').unwrap();
        for (ascending, direction) in [(true, "asc"), (false, "desc")] {
            let sorted = sort_index(&index, 1, ascending, &[condition("age", "lt", "33")]).unwrap();
            let source_rows = sorted.source_rows.clone().unwrap();

            let mut searched = filter_index(&index, &[condition("age", "lt", "33")])
                .unwrap()
                .rows;
            sort_rows(&mut searched, 1, direction);
            assert_eq!(sorted.rows, searched);

            let original = read_rows_from_index(&index, 0, 5).unwrap();
            let by_source: Vec<&Vec<String>> = source_rows.iter().map(|&i| &original[i]).collect();
            assert_eq!(sorted.rows.iter().collect::<Vec<_>>(), by_source);
            if ascending {
                assert_eq!(source_rows, vec![4, 1, 3, 0]);
            }
        }
    }
}
