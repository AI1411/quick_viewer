use calamine::{open_workbook, Data, DataRef, Reader, Xlsx};
use chrono::NaiveDate;
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use zip::ZipArchive;

// ── 公開データ構造 ────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct XlsxSheetMeta {
    pub name: String,
    pub index: usize,
}

#[derive(Debug, Serialize)]
pub struct XlsxInfo {
    pub sheets: Vec<XlsxSheetMeta>,
    pub active_sheet_index: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct XlsxCell {
    pub value: String,
    pub raw: String,
    pub cell_type: String, // "string"|"number"|"integer"|"boolean"|"date"|"empty"|"error"
    pub format_code: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct FreezePane {
    pub rows: u32,
    pub cols: u32,
}

#[derive(Debug, Serialize)]
pub struct XlsxSheetData {
    pub name: String,
    pub rows: Vec<Vec<XlsxCell>>,
    pub total_rows: usize,
    pub total_cols: usize,
    /// rows の各行に含まれる列数 (total_cols が上限を超える場合は切り詰める)
    pub loaded_cols: usize,
    pub freeze_pane: FreezePane,
}

// ── ヘルパー ─────────────────────────────────────────────

/// Excel 日付シリアル値 → ISO 日付文字列
/// Excel は 1900-02-29 を誤って存在するとして扱う（シリアル値 60）
pub(crate) fn serial_to_date_string(serial: f64) -> String {
    if !serial.is_finite() {
        return serial.to_string();
    }
    let n = serial.floor() as i64;
    if n <= 0 {
        return serial.to_string();
    }
    if n == 60 {
        return "1900-02-29".to_string();
    }
    let adjusted = if n > 60 { n - 1 } else { n };
    // 時刻部分を秒に丸めた結果が 24:00:00 になる場合は翌日の 00:00:00 に繰り上げる
    let mut secs = ((serial - serial.floor()) * 86400.0).round() as i64;
    let mut day_offset = adjusted;
    if secs >= 86400 {
        secs -= 86400;
        day_offset += 1;
    }
    // 細工されたファイルの巨大な値で chrono::Duration::days が panic しないよう try_days を使う
    let date = NaiveDate::from_ymd_opt(1899, 12, 31)
        .zip(chrono::TimeDelta::try_days(day_offset))
        .and_then(|(base, days)| base.checked_add_signed(days));
    match date {
        Some(date) if secs > 0 => format!(
            "{} {:02}:{:02}:{:02}",
            date.format("%Y-%m-%d"),
            secs / 3600,
            (secs % 3600) / 60,
            secs % 60
        ),
        Some(date) => date.format("%Y-%m-%d").to_string(),
        None => serial.to_string(),
    }
}

/// Excel 組み込み数値フォーマット ID → フォーマットコード文字列
fn builtin_format_code(id: u32) -> Option<&'static str> {
    match id {
        0 => Some("General"),
        1 => Some("0"),
        2 => Some("0.00"),
        3 => Some("#,##0"),
        4 => Some("#,##0.00"),
        9 => Some("0%"),
        10 => Some("0.00%"),
        11 => Some("0.00E+00"),
        12 => Some("# ?/?"),
        13 => Some("# ??/??"),
        14 => Some("m/d/yyyy"),
        15 => Some("d-mmm-yy"),
        16 => Some("d-mmm"),
        17 => Some("mmm-yy"),
        18 => Some("h:mm AM/PM"),
        19 => Some("h:mm:ss AM/PM"),
        20 => Some("h:mm"),
        21 => Some("h:mm:ss"),
        22 => Some("m/d/yyyy h:mm"),
        37 => Some("#,##0 ;(#,##0)"),
        38 => Some("#,##0 ;[Red](#,##0)"),
        39 => Some("#,##0.00;(#,##0.00)"),
        40 => Some("#,##0.00;[Red](#,##0.00)"),
        45 => Some("mm:ss"),
        46 => Some("[h]:mm:ss"),
        47 => Some("mmss.0"),
        48 => Some("##0.0E+0"),
        49 => Some("@"),
        _ => None,
    }
}

/// xl/styles.xml の文字列を解析し、XF インデックス → フォーマットコードのマップを返す
pub(crate) fn parse_styles_xml(xml: &str) -> Result<HashMap<u32, String>, String> {
    let mut custom_fmts: HashMap<u32, String> = HashMap::new();
    let mut xf_num_fmt_ids: Vec<u32> = Vec::new();

    let mut reader = XmlReader::from_str(xml);
    let mut buf = Vec::new();
    let mut in_num_fmts = false;
    let mut in_cell_xfs = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                match e.name().as_ref() {
                    b"numFmts" => in_num_fmts = true,
                    b"cellXfs" => in_cell_xfs = true,
                    b"numFmt" if in_num_fmts => {
                        let mut fmt_id: Option<u32> = None;
                        let mut fmt_code: Option<String> = None;
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"numFmtId" => {
                                    fmt_id = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .and_then(|s| s.parse().ok());
                                }
                                b"formatCode" => {
                                    fmt_code = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .map(|s| s.to_string());
                                }
                                _ => {}
                            }
                        }
                        if let (Some(id), Some(code)) = (fmt_id, fmt_code) {
                            custom_fmts.insert(id, code);
                        }
                    }
                    b"xf" if in_cell_xfs => {
                        let mut num_fmt_id: u32 = 0;
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"numFmtId" {
                                num_fmt_id = std::str::from_utf8(&attr.value)
                                    .ok()
                                    .and_then(|s| s.parse().ok())
                                    .unwrap_or(0);
                            }
                        }
                        xf_num_fmt_ids.push(num_fmt_id);
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => match e.name().as_ref() {
                b"numFmts" => in_num_fmts = false,
                b"cellXfs" => in_cell_xfs = false,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
        buf.clear();
    }

    let mut result: HashMap<u32, String> = HashMap::new();
    for (xf_idx, num_fmt_id) in xf_num_fmt_ids.iter().enumerate() {
        let code = custom_fmts
            .get(num_fmt_id)
            .cloned()
            .or_else(|| builtin_format_code(*num_fmt_id).map(|s| s.to_string()))
            .unwrap_or_else(|| "General".to_string());
        result.insert(xf_idx as u32, code);
    }

    Ok(result)
}

/// ZIP 内のファイルを最大 `limit` バイトまで文字列として読む。無ければ Ok(None)。
/// ZIP ヘッダの宣言サイズは偽装できるため、実際に読んだ量で上限を判定する。
fn read_zip_entry_limited(xlsx_path: &str, entry: &str, limit: u64) -> Result<Option<String>, String> {
    let file = std::fs::File::open(xlsx_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let f = match archive.by_name(entry) {
        Ok(f) => f,
        Err(_) => return Ok(None),
    };
    let mut content = String::new();
    f.take(limit + 1)
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    if content.len() as u64 > limit {
        return Err(format!("{} exceeds size limit ({} bytes)", entry, limit));
    }
    Ok(Some(content))
}

const MAX_STYLES_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
const MAX_SHEET_XML_SIZE: u64 = 100 * 1024 * 1024; // 100 MB
const MAX_WORKBOOK_XML_SIZE: u64 = 10 * 1024 * 1024; // 10 MB

/// xlsx ファイルから xl/styles.xml を読み込んで parse_styles_xml を呼ぶ
fn load_styles(xlsx_path: &str) -> Result<HashMap<u32, String>, String> {
    match read_zip_entry_limited(xlsx_path, "xl/styles.xml", MAX_STYLES_SIZE)? {
        Some(content) => parse_styles_xml(&content),
        None => Ok(HashMap::new()),
    }
}

/// Excel 列文字列 (A, B, ..., Z, AA, ...) → 0 始まりのインデックス。
/// Excel の最大列 XFD (16384 列) を超える列名は None。
pub(crate) fn col_str_to_index(col: &str) -> Option<u32> {
    const MAX_COLS: u32 = 16_384;
    if col.is_empty() || col.len() > 3 || !col.bytes().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    let n = col.bytes().fold(0u32, |acc, b| acc * 26 + u32::from(b - b'A' + 1));
    (n <= MAX_COLS).then(|| n - 1)
}

/// "A1" → (row=0, col=0) のタプル
pub(crate) fn parse_cell_ref(r: &str) -> Option<(u32, u32)> {
    let col_str: String = r.chars().take_while(|c| c.is_ascii_uppercase()).collect();
    let row_str: String = r.chars().skip(col_str.len()).collect();
    if col_str.is_empty() || row_str.is_empty() {
        return None;
    }
    let col = col_str_to_index(&col_str)?;
    // row は 1-based。0 は無効 → filter で弾いて underflow を防ぐ
    let row_num: u32 = row_str.parse::<u32>().ok().filter(|&r| r >= 1)?;
    Some((row_num - 1, col))
}

/// xl/worksheets/sheetN.xml 文字列を解析し、
/// ((row, col) → xf_index) マップとフリーズペイン情報を返す
pub(crate) fn parse_sheet_xml(
    xml: &str,
) -> Result<(HashMap<(u32, u32), u32>, FreezePane), String> {
    let mut cell_xf_map: HashMap<(u32, u32), u32> = HashMap::new();
    let mut freeze = FreezePane { rows: 0, cols: 0 };

    let mut reader = XmlReader::from_str(xml);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                match e.name().as_ref() {
                    b"pane" => {
                        let mut state = String::new();
                        let mut y_split: u32 = 0;
                        let mut x_split: u32 = 0;
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"state" => {
                                    state = std::str::from_utf8(&attr.value)
                                        .unwrap_or("")
                                        .to_string();
                                }
                                b"ySplit" => {
                                    y_split = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0);
                                }
                                b"xSplit" => {
                                    x_split = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0);
                                }
                                _ => {}
                            }
                        }
                        if state == "frozen" || state == "frozenSplit" {
                            freeze.rows = y_split;
                            freeze.cols = x_split;
                        }
                    }
                    b"c" => {
                        let mut cell_ref: Option<String> = None;
                        let mut xf_idx: u32 = 0;
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"r" => {
                                    cell_ref = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .map(|s| s.to_string());
                                }
                                b"s" => {
                                    xf_idx = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0);
                                }
                                _ => {}
                            }
                        }
                        if let Some(r) = cell_ref {
                            if let Some(pos) = parse_cell_ref(&r) {
                                cell_xf_map.insert(pos, xf_idx);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
        buf.clear();
    }

    Ok((cell_xf_map, freeze))
}

/// xlsx ファイルから指定シートの XML を読み込んで parse_sheet_xml を呼ぶ
fn load_sheet_xml(
    xlsx_path: &str,
    sheet_file_name: &str,
) -> Result<(HashMap<(u32, u32), u32>, FreezePane), String> {
    match read_zip_entry_limited(xlsx_path, sheet_file_name, MAX_SHEET_XML_SIZE)? {
        Some(content) => parse_sheet_xml(&content),
        None => Ok((HashMap::new(), FreezePane::default())),
    }
}

/// 書式コードから日付トークンと無関係な部分を除く。
/// `[Red]` `[$-411]` などの角括弧、`"..."` の文字列リテラル、
/// `\x` (エスケープ) `_x` (幅埋め) `*x` (繰り返し) の次の1文字。
fn strip_format_literals(fmt: &str) -> String {
    let mut out = String::with_capacity(fmt.len());
    let mut chars = fmt.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => chars.by_ref().take_while(|&c| c != '"').for_each(drop),
            '[' => chars.by_ref().take_while(|&c| c != ']').for_each(drop),
            '\\' | '_' | '*' => {
                chars.next();
            }
            _ => out.push(c),
        }
    }
    out
}

/// フォーマットコード文字列が日付系かどうかを判定する
fn is_date_format_code(fmt: &str) -> bool {
    let f = strip_format_literals(fmt).to_lowercase();
    if f.contains('%') || f.contains('$') || f.contains('¥') || f.contains('€') {
        return false;
    }
    (f.contains('y') || f.contains('d') || f.contains('h'))
        && (f.contains('m') || f.contains('y') || f.contains('d'))
}

/// calamine Data セル + フォーマットコードを XlsxCell に変換する
pub(crate) fn convert_cell(data: &Data, format_code: Option<String>) -> XlsxCell {
    let is_date_fmt = format_code
        .as_deref()
        .map(is_date_format_code)
        .unwrap_or(false);

    match data {
        Data::Empty => XlsxCell {
            value: String::new(),
            raw: String::new(),
            cell_type: "empty".to_string(),
            format_code,
        },
        Data::String(s) => XlsxCell {
            value: s.clone(),
            raw: s.clone(),
            cell_type: "string".to_string(),
            format_code,
        },
        Data::Int(i) => XlsxCell {
            value: i.to_string(),
            raw: i.to_string(),
            cell_type: "integer".to_string(),
            format_code,
        },
        Data::Float(f) => {
            if is_date_fmt {
                let date_str = serial_to_date_string(*f);
                XlsxCell {
                    value: date_str.clone(),
                    raw: f.to_string(),
                    cell_type: "date".to_string(),
                    format_code,
                }
            } else {
                XlsxCell {
                    value: f.to_string(),
                    raw: f.to_string(),
                    cell_type: "number".to_string(),
                    format_code,
                }
            }
        }
        Data::Bool(b) => XlsxCell {
            value: if *b { "TRUE" } else { "FALSE" }.to_string(),
            raw: b.to_string(),
            cell_type: "boolean".to_string(),
            format_code,
        },
        Data::DateTime(dt) => {
            let serial = dt.as_f64();
            let date_str = serial_to_date_string(serial);
            XlsxCell {
                value: date_str,
                raw: serial.to_string(),
                cell_type: "date".to_string(),
                format_code,
            }
        }
        Data::DateTimeIso(s) => XlsxCell {
            value: s.clone(),
            raw: s.clone(),
            cell_type: "date".to_string(),
            format_code,
        },
        Data::DurationIso(s) => XlsxCell {
            value: s.clone(),
            raw: s.clone(),
            cell_type: "string".to_string(),
            format_code,
        },
        Data::Error(e) => XlsxCell {
            value: format!("#ERR:{:?}", e),
            raw: format!("{:?}", e),
            cell_type: "error".to_string(),
            format_code,
        },
    }
}

/// xl/workbook.xml を解析してシート名 → rId のマップを返す
fn parse_workbook_xml(xml: &str) -> HashMap<String, String> {
    let mut name_to_rid: HashMap<String, String> = HashMap::new();
    let mut reader = XmlReader::from_str(xml);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e))
                if e.name().as_ref() == b"sheet" =>
            {
                let mut name = String::new();
                let mut rid = String::new();
                for attr in e.attributes().flatten() {
                    match attr.key.as_ref() {
                        b"name" => {
                            name = std::str::from_utf8(&attr.value)
                                .unwrap_or("")
                                .to_string();
                        }
                        b"r:id" => {
                            rid = std::str::from_utf8(&attr.value)
                                .unwrap_or("")
                                .to_string();
                        }
                        _ => {}
                    }
                }
                if !name.is_empty() && !rid.is_empty() {
                    name_to_rid.insert(name, rid);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    name_to_rid
}

/// workbook.xml.rels の Target を ZIP 内のパスにする。
/// 通常は "worksheets/sheet1.xml" (xl/ からの相対) だが、"/xl/worksheets/sheet1.xml"
/// のようなパッケージ絶対パスで書くツールもある。
fn resolve_rels_target(target: &str) -> String {
    match target.strip_prefix('/') {
        Some(absolute) => absolute.to_string(),
        None => format!("xl/{}", target),
    }
}

/// xl/_rels/workbook.xml.rels を解析して rId → ファイルパスのマップを返す
fn parse_workbook_rels_xml(xml: &str) -> HashMap<String, String> {
    let mut rid_to_path: HashMap<String, String> = HashMap::new();
    let mut reader = XmlReader::from_str(xml);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e))
                if e.name().as_ref() == b"Relationship" =>
            {
                let mut id = String::new();
                let mut target = String::new();
                for attr in e.attributes().flatten() {
                    match attr.key.as_ref() {
                        b"Id" => {
                            id = std::str::from_utf8(&attr.value)
                                .unwrap_or("")
                                .to_string();
                        }
                        b"Target" => {
                            target = std::str::from_utf8(&attr.value)
                                .unwrap_or("")
                                .to_string();
                        }
                        _ => {}
                    }
                }
                if !id.is_empty() && !target.is_empty() {
                    rid_to_path.insert(id, resolve_rels_target(&target));
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    rid_to_path
}

/// xlsx ファイルからシート名 → xl/worksheets/sheetN.xml パスのマップを構築する
fn load_sheet_file_map(xlsx_path: &str) -> HashMap<String, String> {
    let read = |entry| read_zip_entry_limited(xlsx_path, entry, MAX_WORKBOOK_XML_SIZE).ok().flatten();
    let (Some(workbook), Some(rels)) = (read("xl/workbook.xml"), read("xl/_rels/workbook.xml.rels")) else {
        return HashMap::new();
    };
    let rid_to_path = parse_workbook_rels_xml(&rels);
    parse_workbook_xml(&workbook)
        .into_iter()
        .filter_map(|(name, rid)| rid_to_path.get(&rid).map(|path| (name, path.clone())))
        .collect()
}

// ── セルのストリーミング読み出し ─────────────────────────

type Workbook = Xlsx<std::io::BufReader<std::fs::File>>;

/// 1 シートの表示上限。calamine の worksheet_range は使用範囲の幅×高さの
/// 密な配列を確保するため、A1 と XFD1048576 の 2 セルだけのファイルでも
/// 巨大なメモリを使う。セルを 1 つずつ読み、この範囲だけを保持する。
const MAX_DISPLAY_ROWS: usize = 10_000;
const MAX_DISPLAY_COLS: usize = 1_000;
const MAX_DISPLAY_CELLS: usize = 1_000_000;
/// エクスポートする CSV の上限 (行×列)。巨大な空範囲で出力が数 GB になるのを防ぐ。
const MAX_EXPORT_CELLS: usize = 50_000_000;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Bounds {
    row_start: u32,
    row_end: u32,
    col_start: u32,
    col_end: u32,
}

impl Bounds {
    fn rows(&self) -> usize {
        (self.row_end - self.row_start) as usize + 1
    }
    fn cols(&self) -> usize {
        (self.col_end - self.col_start) as usize + 1
    }
}

/// 空でないセルを 1 つずつ `f` に渡す。シート全体を密な配列に展開しない。
fn for_each_cell(
    workbook: &mut Workbook,
    sheet_name: &str,
    mut f: impl FnMut(u32, u32, &DataRef),
) -> Result<(), String> {
    let mut reader = workbook
        .worksheet_cells_reader(sheet_name)
        .map_err(|e| e.to_string())?;
    while let Some(cell) = reader.next_cell().map_err(|e| e.to_string())? {
        if !matches!(cell.get_value(), DataRef::Empty) {
            let (row, col) = cell.get_position();
            f(row, col, cell.get_value());
        }
    }
    Ok(())
}

fn sheet_bounds(workbook: &mut Workbook, sheet_name: &str) -> Result<Option<Bounds>, String> {
    let mut bounds: Option<Bounds> = None;
    for_each_cell(workbook, sheet_name, |row, col, _| {
        bounds = Some(match bounds {
            None => Bounds { row_start: row, row_end: row, col_start: col, col_end: col },
            Some(b) => Bounds {
                row_start: b.row_start.min(row),
                row_end: b.row_end.max(row),
                col_start: b.col_start.min(col),
                col_end: b.col_end.max(col),
            },
        });
    })?;
    Ok(bounds)
}

fn display_size(total_rows: usize, total_cols: usize) -> (usize, usize) {
    let cols = total_cols.min(MAX_DISPLAY_COLS);
    let rows = if cols == 0 {
        0
    } else {
        total_rows.min(MAX_DISPLAY_ROWS).min(MAX_DISPLAY_CELLS / cols)
    };
    (rows, cols)
}

fn export_cell_string(data: &Data) -> String {
    match data {
        Data::String(s) => s.clone(),
        Data::Float(f) => f.to_string(),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        Data::DateTime(dt) => serial_to_date_string(dt.as_f64()),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{:?}", e),
        Data::Empty => String::new(),
    }
}

fn column_letters(index: usize) -> String {
    let mut result = String::new();
    let mut n = index + 1;
    while n > 0 {
        let rem = (n - 1) % 26;
        result.insert(0, (b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    result
}

// ── Tauri コマンド ────────────────────────────────────────

#[tauri::command(async)]
pub fn read_xlsx(path: String) -> Result<XlsxInfo, String> {
    crate::utils::catch_panic(move || {
        let workbook: Xlsx<_> = open_workbook::<Xlsx<_>, _>(&path).map_err(|e| e.to_string())?;
        let names = workbook.sheet_names().to_vec();
        let sheets = names
            .into_iter()
            .enumerate()
            .map(|(index, name)| XlsxSheetMeta { name, index })
            .collect();
        Ok(XlsxInfo {
            sheets,
            active_sheet_index: 0,
        })
    })
}

#[tauri::command(async)]
pub fn read_xlsx_sheet(path: String, sheet_name: String) -> Result<XlsxSheetData, String> {
    crate::utils::catch_panic(move || {
        let mut workbook: Workbook = open_workbook(&path).map_err(|e: calamine::XlsxError| e.to_string())?;
        let bounds = sheet_bounds(&mut workbook, &sheet_name)?;
        let (total_rows, total_cols) = bounds.map_or((0, 0), |b| (b.rows(), b.cols()));
        let (display_rows, display_cols) = display_size(total_rows, total_cols);

        let xf_to_fmt = load_styles(&path).unwrap_or_default();
        // シートの XML が特定できないときに sheet1.xml を当てると、別シートの書式とフリーズを表示してしまう
        let (cell_xf_map, mut freeze_pane) = load_sheet_file_map(&path)
            .get(&sheet_name)
            .and_then(|sheet_file| load_sheet_xml(&path, sheet_file).ok())
            .unwrap_or_default();
        freeze_pane.rows = freeze_pane.rows.min(display_rows as u32);
        freeze_pane.cols = freeze_pane.cols.min(display_cols as u32);

        let empty = convert_cell(&Data::Empty, None);
        let mut rows: Vec<Vec<XlsxCell>> = vec![vec![empty; display_cols]; display_rows];
        if let Some(b) = bounds {
            for_each_cell(&mut workbook, &sheet_name, |row, col, value| {
                let (r, c) = ((row - b.row_start) as usize, (col - b.col_start) as usize);
                if r < display_rows && c < display_cols {
                    let format_code = cell_xf_map
                        .get(&(row, col))
                        .and_then(|xf| xf_to_fmt.get(xf))
                        .cloned();
                    rows[r][c] = convert_cell(&Data::from(value.clone()), format_code);
                }
            })?;
        }

        Ok(XlsxSheetData {
            name: sheet_name,
            rows,
            total_rows,
            total_cols,
            loaded_cols: display_cols,
            freeze_pane,
        })
    })
}

/// XLSX シートを CSV としてエクスポートする。フィルタ条件（AND 複合）を適用可能。
#[tauri::command(async)]
pub fn export_xlsx_sheet_as_csv(
    path: String,
    sheet_name: String,
    output_path: String,
    conditions: Vec<crate::csv_commands::FilterCondition>,
) -> Result<(), String> {
    crate::utils::catch_panic(move || {
        let mut workbook: Workbook = open_workbook(&path).map_err(|e: calamine::XlsxError| e.to_string())?;
        let b = sheet_bounds(&mut workbook, &sheet_name)?
            .ok_or_else(|| "シートにデータがありません".to_string())?;
        if b.rows().saturating_mul(b.cols()) > MAX_EXPORT_CELLS {
            return Err(format!(
                "シートが大きすぎるためエクスポートできません ({} 行 × {} 列)",
                b.rows(),
                b.cols()
            ));
        }

        // 実在するセルだけを保持し、行順に並べてから 1 行ずつ書き出す
        let mut cells: Vec<(u32, u32, String)> = Vec::new();
        for_each_cell(&mut workbook, &sheet_name, |row, col, value| {
            cells.push((row, col, export_cell_string(&Data::from(value.clone()))));
        })?;
        cells.sort_unstable_by_key(|(row, col, _)| (*row, *col));

        let headers: Vec<String> = (0..b.cols()).map(column_letters).collect();
        let out_file = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
        let mut wtr = csv::WriterBuilder::new().delimiter(b',').from_writer(out_file);
        wtr.write_record(&headers).map_err(|e| e.to_string())?;

        let mut cells = cells.into_iter().peekable();
        for row_index in b.row_start..=b.row_end {
            let mut row = vec![String::new(); b.cols()];
            while let Some((_, col, value)) = cells.next_if(|(r, _, _)| *r == row_index) {
                row[(col - b.col_start) as usize] = value;
            }
            if conditions.is_empty()
                || crate::csv_commands::row_matches_all(&headers, &row, &conditions)
            {
                wtr.write_record(&row).map_err(|e| e.to_string())?;
            }
        }
        wtr.flush().map_err(|e| e.to_string())?;

        Ok(())
    })
}

// ── テスト ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{ExcelDateTime, ExcelDateTimeType};

    // serial_to_date_string tests

    #[test]
    fn serial_to_date_day1_is_jan_1_1900() {
        assert_eq!(serial_to_date_string(1.0), "1900-01-01");
    }

    #[test]
    fn serial_to_date_day59_is_feb_28_1900() {
        assert_eq!(serial_to_date_string(59.0), "1900-02-28");
    }

    #[test]
    fn serial_to_date_phantom_leap_day() {
        assert_eq!(serial_to_date_string(60.0), "1900-02-29");
    }

    #[test]
    fn serial_to_date_day61_is_mar_1_1900() {
        assert_eq!(serial_to_date_string(61.0), "1900-03-01");
    }

    #[test]
    fn serial_to_date_modern_date() {
        // 2024-01-01 = シリアル値 45292
        assert_eq!(serial_to_date_string(45292.0), "2024-01-01");
    }

    #[test]
    fn serial_to_date_with_time() {
        assert_eq!(serial_to_date_string(45292.5), "2024-01-01 12:00:00");
    }

    // parse_styles_xml tests

    #[test]
    fn parse_styles_xml_extracts_custom_numfmt() {
        let xml = r#"<?xml version="1.0"?>
<styleSheet>
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="$#,##0.00"/>
    <numFmt numFmtId="165" formatCode="0.00%"/>
  </numFmts>
  <cellXfs count="3">
    <xf numFmtId="0"/>
    <xf numFmtId="164"/>
    <xf numFmtId="165"/>
  </cellXfs>
</styleSheet>"#;
        let map = parse_styles_xml(xml).unwrap();
        assert_eq!(map.get(&0).map(|s| s.as_str()), Some("General"));
        assert_eq!(map.get(&1).map(|s| s.as_str()), Some("$#,##0.00"));
        assert_eq!(map.get(&2).map(|s| s.as_str()), Some("0.00%"));
    }

    #[test]
    fn parse_styles_xml_builtin_date_format() {
        let xml = r#"<?xml version="1.0"?>
<styleSheet>
  <numFmts count="0"/>
  <cellXfs count="2">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
  </cellXfs>
</styleSheet>"#;
        let map = parse_styles_xml(xml).unwrap();
        assert_eq!(map.get(&1).map(|s| s.as_str()), Some("m/d/yyyy"));
    }

    // col_str_to_index / parse_cell_ref tests

    #[test]
    fn col_str_to_index_basic() {
        assert_eq!(col_str_to_index("A"), Some(0));
        assert_eq!(col_str_to_index("Z"), Some(25));
        assert_eq!(col_str_to_index("AA"), Some(26));
        assert_eq!(col_str_to_index("AB"), Some(27));
        assert_eq!(col_str_to_index("XFD"), Some(16_383));
    }

    #[test]
    fn col_str_to_index_rejects_columns_beyond_excel_limit() {
        assert_eq!(col_str_to_index("XFE"), None);
        assert_eq!(col_str_to_index("AAAAAAAAAA"), None);
        assert_eq!(parse_cell_ref("AAAAAAAAAA1"), None);
    }

    #[test]
    fn parse_cell_ref_basic() {
        assert_eq!(parse_cell_ref("A1"), Some((0, 0)));
        assert_eq!(parse_cell_ref("B2"), Some((1, 1)));
        assert_eq!(parse_cell_ref("AA10"), Some((9, 26)));
    }

    #[test]
    fn parse_cell_ref_rejects_row_zero() {
        assert_eq!(parse_cell_ref("A0"), None);
    }

    #[test]
    fn parse_cell_ref_rejects_empty_col() {
        assert_eq!(parse_cell_ref("1"), None);
        assert_eq!(parse_cell_ref(""), None);
    }

    // parse_sheet_xml tests

    #[test]
    fn parse_sheet_xml_freeze_and_styles() {
        let xml = r#"<?xml version="1.0"?>
<worksheet>
  <sheetViews>
    <sheetView>
      <pane ySplit="1" xSplit="2" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetData>
    <row r="1">
      <c r="A1" s="3" t="s"><v>0</v></c>
      <c r="B1" s="1"><v>123.45</v></c>
    </row>
  </sheetData>
</worksheet>"#;
        let (cell_xf, freeze) = parse_sheet_xml(xml).unwrap();
        assert_eq!(cell_xf.get(&(0, 0)), Some(&3u32));
        assert_eq!(cell_xf.get(&(0, 1)), Some(&1u32));
        assert_eq!(freeze.rows, 1);
        assert_eq!(freeze.cols, 2);
    }

    // convert_cell tests

    fn write_test_xlsx(name: &str, cell_xfs: &str, sheet_body: &str) -> std::path::PathBuf {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let path = std::env::temp_dir().join(format!("qv_{}_{}.xlsx", name, std::process::id()));
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let files = [
            ("[Content_Types].xml", r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#.to_string()),
            ("_rels/.rels", r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_string()),
            ("xl/workbook.xml", r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_string()),
            ("xl/_rels/workbook.xml.rels", r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#.to_string()),
            ("xl/styles.xml", format!(r#"<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs>{cell_xfs}</cellXfs></styleSheet>"#)),
            ("xl/worksheets/sheet1.xml", format!(r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{sheet_body}</worksheet>"#)),
        ];
        for (name, content) in files {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn rels_target_accepts_package_absolute_paths() {
        assert_eq!(resolve_rels_target("worksheets/sheet2.xml"), "xl/worksheets/sheet2.xml");
        assert_eq!(resolve_rels_target("/xl/worksheets/sheet2.xml"), "xl/worksheets/sheet2.xml");
    }

    #[test]
    fn zip_entry_over_limit_is_rejected_by_actual_size() {
        let path = write_test_xlsx("limit", r#"<xf numFmtId="0"/>"#, "<sheetData/>");
        let p = path.to_string_lossy().into_owned();
        let small = read_zip_entry_limited(&p, "xl/workbook.xml", 10_000).unwrap();
        let too_big = read_zip_entry_limited(&p, "xl/workbook.xml", 10);
        let missing = read_zip_entry_limited(&p, "xl/missing.xml", 10).unwrap();
        std::fs::remove_file(&path).ok();
        assert!(small.unwrap().contains("<sheets>"));
        assert!(too_big.is_err());
        assert!(missing.is_none());
    }

    #[test]
    fn sparse_sheet_is_read_without_materializing_the_whole_range() {
        let path = write_test_xlsx(
            "sparse",
            r#"<xf numFmtId="0"/>"#,
            r#"<sheetViews><sheetView><pane ySplit="5000" xSplit="16384" state="frozen"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="XFD1048576"><v>2</v></c></row></sheetData>"#,
        );
        let data = read_xlsx_sheet(path.to_string_lossy().into_owned(), "Sheet1".into()).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!((data.total_rows, data.total_cols), (1_048_576, 16_384));
        assert_eq!(data.loaded_cols, MAX_DISPLAY_COLS);
        assert_eq!(data.rows.len(), MAX_DISPLAY_CELLS / MAX_DISPLAY_COLS);
        assert!(data.rows.iter().all(|r| r.len() == MAX_DISPLAY_COLS));
        assert_eq!(data.rows[0][0].value, "1");
        // フリーズ行・列は読み込んだ範囲を超えない
        assert_eq!(data.freeze_pane.rows as usize, data.rows.len());
        assert_eq!(data.freeze_pane.cols as usize, MAX_DISPLAY_COLS);
    }

    #[test]
    fn small_sheet_keeps_all_cells_and_formats() {
        let path = write_test_xlsx(
            "small",
            r#"<xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="38" applyNumberFormat="1"/>"#,
            r#"<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="B1" s="1"><v>45292</v></c><c r="C1" s="2"><v>1234</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c></row></sheetData>"#,
        );
        let data = read_xlsx_sheet(path.to_string_lossy().into_owned(), "Sheet1".into()).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!((data.total_rows, data.total_cols, data.loaded_cols), (2, 3, 3));
        let values: Vec<Vec<&str>> = data.rows.iter().map(|r| r.iter().map(|c| c.value.as_str()).collect()).collect();
        assert_eq!(values, vec![vec!["name", "2024-01-01", "1234"], vec!["x", "", ""]]);
        assert_eq!(data.rows[0][2].cell_type, "number");
    }

    #[test]
    fn export_streams_rows_and_applies_filters() {
        let path = write_test_xlsx(
            "export",
            r#"<xf numFmtId="0"/>"#,
            r#"<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>apple</t></is></c><c r="B1"><v>3</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>banana</t></is></c></row><row r="4"><c r="B4"><v>7</v></c></row></sheetData>"#,
        );
        let out = std::env::temp_dir().join(format!("qv_export_{}.csv", std::process::id()));
        let input = path.to_string_lossy().into_owned();
        let output = out.to_string_lossy().into_owned();
        export_xlsx_sheet_as_csv(input.clone(), "Sheet1".into(), output.clone(), vec![]).unwrap();
        let all = std::fs::read_to_string(&out).unwrap();
        let cond = crate::csv_commands::FilterCondition {
            column: "B".into(),
            filter_type: "gt".into(),
            value: "5".into(),
        };
        export_xlsx_sheet_as_csv(input, "Sheet1".into(), output, vec![cond]).unwrap();
        let filtered = std::fs::read_to_string(&out).unwrap();
        std::fs::remove_file(&path).ok();
        std::fs::remove_file(&out).ok();
        assert_eq!(all, "A,B\napple,3\nbanana,\n,\n,7\n");
        assert_eq!(filtered, "A,B\n,7\n");
    }

    #[test]
    fn serial_to_date_out_of_range_values_do_not_panic() {
        assert_eq!(serial_to_date_string(1e15), "1000000000000000");
        assert_eq!(serial_to_date_string(f64::INFINITY), "inf");
        assert_eq!(serial_to_date_string(f64::NAN), "NaN");
        assert_eq!(serial_to_date_string(f64::MAX), f64::MAX.to_string());
    }

    #[test]
    fn serial_to_date_rounds_up_to_next_day_instead_of_24h() {
        // 2023-03-15 23:59:59.9 は "2023-03-15 24:00:00" ではなく翌日 00:00:00 になる
        assert_eq!(serial_to_date_string(45000.0), "2023-03-15");
        let almost_midnight = 45000.0 + (86399.9 / 86400.0);
        assert_eq!(serial_to_date_string(almost_midnight), "2023-03-16");
    }

    #[test]
    fn number_formats_with_color_or_literals_are_not_dates() {
        for fmt in [
            "#,##0 ;(#,##0)",
            "#,##0 ;[Red](#,##0)",
            "#,##0.00;[Red](#,##0.00)",
            "#,##0;[Red]-#,##0",
            "0\"days\"",
            "[DBNum1]General",
            "General",
            "0.00",
            "_(* #,##0_);_(* (#,##0);_(* \"-\"_);_(@_)",
        ] {
            assert!(!is_date_format_code(fmt), "{fmt} should not be a date format");
        }
    }

    #[test]
    fn date_formats_are_detected_even_with_locale_prefix() {
        for fmt in ["yyyy/mm/dd", "m/d/yyyy", "d-mmm-yy", "[$-411]ggge\"年\"m\"月\"d\"日\"", "yyyy\"年\"m\"月\"d\"日\""] {
            assert!(is_date_format_code(fmt), "{fmt} should be a date format");
        }
    }

    #[test]
    fn red_number_format_cell_is_shown_as_number() {
        let cell = convert_cell(&Data::Float(1234.0), Some("#,##0 ;[Red](#,##0)".to_string()));
        assert_eq!(cell.cell_type, "number");
        assert_eq!(cell.value, "1234");
    }

    #[test]
    fn convert_cell_empty() {
        let cell = convert_cell(&Data::Empty, None);
        assert_eq!(cell.cell_type, "empty");
        assert_eq!(cell.value, "");
    }

    #[test]
    fn convert_cell_string() {
        let cell = convert_cell(&Data::String("hello".to_string()), None);
        assert_eq!(cell.cell_type, "string");
        assert_eq!(cell.value, "hello");
    }

    #[test]
    fn convert_cell_float_number() {
        let cell = convert_cell(&Data::Float(3.14), Some("#,##0.00".to_string()));
        assert_eq!(cell.cell_type, "number");
        assert_eq!(cell.raw, "3.14");
    }

    #[test]
    fn convert_cell_float_as_date_when_date_format() {
        let cell = convert_cell(&Data::Float(45292.0), Some("m/d/yyyy".to_string()));
        assert_eq!(cell.cell_type, "date");
        assert_eq!(cell.value, "2024-01-01");
    }

    #[test]
    fn convert_cell_datetime_variant() {
        let dt = ExcelDateTime::new(45292.0, ExcelDateTimeType::DateTime, false);
        let cell = convert_cell(&Data::DateTime(dt), None);
        assert_eq!(cell.cell_type, "date");
        assert_eq!(cell.value, "2024-01-01");
    }

    #[test]
    fn convert_cell_bool() {
        let cell = convert_cell(&Data::Bool(true), None);
        assert_eq!(cell.cell_type, "boolean");
        assert_eq!(cell.value, "TRUE");
    }
}
