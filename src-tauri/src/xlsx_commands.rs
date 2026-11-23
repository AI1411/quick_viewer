use calamine::{open_workbook, Data, Range, Reader, Xlsx};
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
    pub freeze_pane: FreezePane,
}

// ── ヘルパー ─────────────────────────────────────────────

/// Excel 日付シリアル値 → ISO 日付文字列
/// Excel は 1900-02-29 を誤って存在するとして扱う（シリアル値 60）
pub(crate) fn serial_to_date_string(serial: f64) -> String {
    let n = serial.floor() as i64;
    if n <= 0 {
        return serial.to_string();
    }
    if n == 60 {
        return "1900-02-29".to_string();
    }
    let adjusted = if n > 60 { n - 1 } else { n };
    let base = match NaiveDate::from_ymd_opt(1899, 12, 31) {
        Some(d) => d,
        None => return serial.to_string(),
    };
    match base.checked_add_signed(chrono::Duration::days(adjusted)) {
        Some(date) => {
            let frac = serial - serial.floor();
            if frac > 1e-6 {
                let total_secs = (frac * 86400.0).round() as u32;
                let h = total_secs / 3600;
                let m = (total_secs % 3600) / 60;
                let s = total_secs % 60;
                format!("{} {:02}:{:02}:{:02}", date.format("%Y-%m-%d"), h, m, s)
            } else {
                date.format("%Y-%m-%d").to_string()
            }
        }
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

/// xlsx ファイルから xl/styles.xml を読み込んで parse_styles_xml を呼ぶ
fn load_styles(xlsx_path: &str) -> Result<HashMap<u32, String>, String> {
    let file = std::fs::File::open(xlsx_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut content = String::new();
    match archive.by_name("xl/styles.xml") {
        Ok(mut f) => {
            const MAX_STYLES_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
            if f.size() > MAX_STYLES_SIZE {
                return Err("xl/styles.xml exceeds size limit (10 MB)".to_string());
            }
            f.read_to_string(&mut content).map_err(|e| e.to_string())?;
        }
        Err(_) => return Ok(HashMap::new()),
    }
    parse_styles_xml(&content)
}

/// Excel 列文字列 (A, B, ..., Z, AA, ...) → 0 始まりのインデックス
pub(crate) fn col_str_to_index(col: &str) -> u32 {
    col.chars()
        .fold(0u32, |acc, c| acc * 26 + (c as u32 - b'A' as u32 + 1))
        - 1
}

/// "A1" → (row=0, col=0) のタプル
pub(crate) fn parse_cell_ref(r: &str) -> Option<(u32, u32)> {
    let col_str: String = r.chars().take_while(|c| c.is_ascii_uppercase()).collect();
    let row_str: String = r.chars().skip(col_str.len()).collect();
    if col_str.is_empty() || row_str.is_empty() {
        return None;
    }
    let col = col_str_to_index(&col_str);
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
    let file = std::fs::File::open(xlsx_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut content = String::new();
    match archive.by_name(sheet_file_name) {
        Ok(mut f) => {
            const MAX_SHEET_SIZE: u64 = 100 * 1024 * 1024; // 100 MB
            if f.size() > MAX_SHEET_SIZE {
                return Err(format!(
                    "{} exceeds size limit (100 MB)",
                    sheet_file_name
                ));
            }
            f.read_to_string(&mut content).map_err(|e| e.to_string())?;
        }
        Err(_) => return Ok((HashMap::new(), FreezePane::default())),
    }
    parse_sheet_xml(&content)
}

/// 色指定 `[...]`、文字列リテラル `"..."`、`\` エスケープを取り除く
/// （日付トークン判定の前処理用）
fn strip_non_format_tokens(fmt: &str) -> String {
    let mut result = String::with_capacity(fmt.len());
    let mut chars = fmt.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                // 次の1文字をスキップ（エスケープされたリテラル）
                chars.next();
            }
            '"' => {
                while let Some(qc) = chars.next() {
                    if qc == '"' {
                        break;
                    }
                }
            }
            '[' => {
                while let Some(bc) = chars.next() {
                    if bc == ']' {
                        break;
                    }
                }
            }
            _ => result.push(c),
        }
    }
    result
}

/// フォーマットコード文字列が日付系かどうかを判定する
fn is_date_format_code(fmt: &str) -> bool {
    if fmt.contains('%') || fmt.contains('$') || fmt.contains('¥') || fmt.contains('€') {
        return false;
    }
    // [Red] の d や "days" の d を日付トークンと誤認しないよう除去してから判定
    let f = strip_non_format_tokens(fmt).to_lowercase();
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
                    // Target は "worksheets/sheet1.xml" 形式なので "xl/" を前置する
                    rid_to_path.insert(id, format!("xl/{}", target));
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
    let name_to_rid = {
        let file = match std::fs::File::open(xlsx_path) {
            Ok(f) => f,
            Err(_) => return HashMap::new(),
        };
        let mut archive = match ZipArchive::new(file) {
            Ok(a) => a,
            Err(_) => return HashMap::new(),
        };
        let mut content = String::new();
        if archive
            .by_name("xl/workbook.xml")
            .ok()
            .and_then(|mut f| f.read_to_string(&mut content).ok())
            .is_none()
        {
            return HashMap::new();
        }
        parse_workbook_xml(&content)
    };

    let rid_to_path = {
        let file = match std::fs::File::open(xlsx_path) {
            Ok(f) => f,
            Err(_) => return HashMap::new(),
        };
        let mut archive = match ZipArchive::new(file) {
            Ok(a) => a,
            Err(_) => return HashMap::new(),
        };
        let mut content = String::new();
        if archive
            .by_name("xl/_rels/workbook.xml.rels")
            .ok()
            .and_then(|mut f| f.read_to_string(&mut content).ok())
            .is_none()
        {
            return HashMap::new();
        }
        parse_workbook_rels_xml(&content)
    };

    name_to_rid
        .into_iter()
        .filter_map(|(name, rid)| rid_to_path.get(&rid).map(|path| (name, path.clone())))
        .collect()
}

// ── Tauri コマンド ────────────────────────────────────────

#[tauri::command(async)]
pub fn read_xlsx(path: String) -> Result<XlsxInfo, String> {
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
}

#[tauri::command(async)]
pub fn read_xlsx_sheet(path: String, sheet_name: String) -> Result<XlsxSheetData, String> {
    let mut workbook: Xlsx<_> = open_workbook::<Xlsx<_>, _>(&path).map_err(|e| e.to_string())?;
    let range: Range<Data> = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| e.to_string())?;

    let (total_rows, total_cols) = range.get_size();

    let xf_to_fmt = load_styles(&path).unwrap_or_default();

    let sheet_file_map = load_sheet_file_map(&path);
    let sheet_file = sheet_file_map
        .get(&sheet_name)
        .cloned()
        .unwrap_or_else(|| "xl/worksheets/sheet1.xml".to_string());
    let (cell_xf_map, freeze_pane) =
        load_sheet_xml(&path, &sheet_file).unwrap_or_default();

    let (start_row, start_col) = range.start().unwrap_or((0, 0));

    const MAX_DISPLAY_ROWS: usize = 10_000;

    let rows: Vec<Vec<XlsxCell>> = range
        .rows()
        .take(MAX_DISPLAY_ROWS)
        .enumerate()
        .map(|(row_rel, row): (usize, &[Data])| {
            row.iter()
                .enumerate()
                .map(|(col_rel, data)| {
                    let abs_row = start_row + row_rel as u32;
                    let abs_col = start_col + col_rel as u32;
                    let xf_idx = cell_xf_map.get(&(abs_row, abs_col)).copied();
                    let format_code = xf_idx.and_then(|xf| xf_to_fmt.get(&xf)).cloned();
                    convert_cell(data, format_code)
                })
                .collect()
        })
        .collect();

    Ok(XlsxSheetData {
        name: sheet_name,
        rows,
        total_rows,
        total_cols,
        freeze_pane,
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
    let mut workbook: Xlsx<_> = open_workbook::<Xlsx<_>, _>(&path).map_err(|e| e.to_string())?;
    let range: Range<Data> = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| e.to_string())?;

    let (total_rows, total_cols) = range.get_size();
    if total_rows == 0 || total_cols == 0 {
        return Err("シートにデータがありません".to_string());
    }

    // 列ヘッダを生成（A, B, C...）
    let headers: Vec<String> = (0..total_cols)
        .map(|i| {
            let mut result = String::new();
            let mut n = i + 1;
            while n > 0 {
                let rem = (n - 1) % 26;
                result.insert(0, (65 + rem as u8) as char);
                n = (n - 1) / 26;
            }
            result
        })
        .collect();

    // 全行を文字列に変換
    let all_rows: Vec<Vec<String>> = range
        .rows()
        .map(|row| {
            row.iter()
                .map(|data| match data {
                    Data::String(s) => s.clone(),
                    Data::Float(f) => f.to_string(),
                    Data::Int(i) => i.to_string(),
                    Data::Bool(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
                    Data::DateTime(dt) => serial_to_date_string(dt.as_f64()),
                    Data::DateTimeIso(s) => s.clone(),
                    Data::DurationIso(s) => s.clone(),
                    Data::Error(e) => format!("{:?}", e),
                    Data::Empty => String::new(),
                })
                .collect()
        })
        .collect();

    // フィルタ適用
    let filtered = if conditions.is_empty() {
        all_rows
    } else {
        crate::csv_commands::apply_filters(&headers, &all_rows, &conditions)
    };

    // CSV として書き込み
    let out_file = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut wtr = csv::WriterBuilder::new()
        .delimiter(b',')
        .from_writer(out_file);

    wtr.write_record(&headers).map_err(|e| e.to_string())?;
    for row in &filtered {
        wtr.write_record(row).map_err(|e| e.to_string())?;
    }
    wtr.flush().map_err(|e| e.to_string())?;

    Ok(())
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
        assert_eq!(col_str_to_index("A"), 0);
        assert_eq!(col_str_to_index("Z"), 25);
        assert_eq!(col_str_to_index("AA"), 26);
        assert_eq!(col_str_to_index("AB"), 27);
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

    // is_date_format_code tests

    #[test]
    fn is_date_format_code_rejects_red_color_number_formats() {
        assert!(!is_date_format_code("#,##0 ;[Red](#,##0)"));
        assert!(!is_date_format_code("#,##0.00;[Red](#,##0.00)"));
    }

    #[test]
    fn is_date_format_code_rejects_quoted_literal_with_d() {
        assert!(!is_date_format_code(r#"0.0"days""#));
    }

    #[test]
    fn is_date_format_code_rejects_plain_number_format() {
        assert!(!is_date_format_code("#,##0"));
    }

    #[test]
    fn is_date_format_code_accepts_real_date_format() {
        assert!(is_date_format_code("yyyy/mm/dd"));
        assert!(is_date_format_code("m/d/yyyy"));
    }

    #[test]
    fn is_date_format_code_rejects_backslash_escaped_literal() {
        assert!(!is_date_format_code(r"0.0\d\a\y\s"));
    }

    // convert_cell tests

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
    fn convert_cell_float_stays_number_with_red_format() {
        let cell = convert_cell(
            &Data::Float(1234.5),
            Some("#,##0 ;[Red](#,##0)".to_string()),
        );
        assert_eq!(cell.cell_type, "number");
        assert_eq!(cell.value, "1234.5");
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
