//! 画像の表示・変換・圧縮。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, OnceLock};

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::image_engine::{self as engine, Metadata, Rendered, Source};

const MAX_IMAGE_FILE_SIZE: u64 = 1024 * 1024 * 1024; // 1 GB
/// 展開すると 1 画素 4 バイト以上になるため、画素数にも上限を置く (小さなファイルでも
/// 巨大な寸法を名乗れる)。250 メガピクセルで約 1 GB
const MAX_IMAGE_PIXELS: u64 = 250_000_000;
const MAX_BATCH_FILES: usize = 5_000;
/// 変換後プレビューとして webview に渡す上限。超える場合は数値だけ返す
const MAX_RESULT_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const WEBP_MAX_EDGE: u32 = 16_383;

// ── 書き出し形式 ─────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Jpeg,
    Png,
    Heic,
    Avif,
    Webp,
    Tiff,
    Gif,
    Bmp,
}

#[derive(Debug, Clone, Copy)]
enum Encoder {
    ImageIo { type_identifier: &'static str },
    LibWebp,
}

/// 書き出し形式ごとの性質。UI の出し分けと変換処理の両方がこの表だけを見る。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct FormatSpec {
    pub id: OutputFormat,
    pub label: &'static str,
    /// 先頭が既定の拡張子
    pub extensions: &'static [&'static str],
    pub mime: &'static str,
    /// 品質を指定できる (非可逆圧縮)
    pub lossy: bool,
    /// 透過を保持できる。false の形式では白背景に合成される
    pub alpha: bool,
    /// EXIF などのメタデータを引き継げる
    pub keeps_metadata: bool,
    #[serde(skip)]
    encoder: Encoder,
}

const fn image_io(type_identifier: &'static str) -> Encoder {
    Encoder::ImageIo { type_identifier }
}

#[rustfmt::skip]
const FORMATS: &[FormatSpec] = &[
    FormatSpec { id: OutputFormat::Jpeg, label: "JPEG", extensions: &["jpg", "jpeg"], mime: "image/jpeg", lossy: true,  alpha: false, keeps_metadata: true,  encoder: image_io("public.jpeg") },
    FormatSpec { id: OutputFormat::Png,  label: "PNG",  extensions: &["png"],         mime: "image/png",  lossy: false, alpha: true,  keeps_metadata: true,  encoder: image_io("public.png") },
    FormatSpec { id: OutputFormat::Heic, label: "HEIC", extensions: &["heic"],        mime: "image/heic", lossy: true,  alpha: true,  keeps_metadata: true,  encoder: image_io("public.heic") },
    FormatSpec { id: OutputFormat::Avif, label: "AVIF", extensions: &["avif"],        mime: "image/avif", lossy: true,  alpha: true,  keeps_metadata: true,  encoder: image_io("public.avif") },
    FormatSpec { id: OutputFormat::Webp, label: "WebP", extensions: &["webp"],        mime: "image/webp", lossy: true,  alpha: true,  keeps_metadata: false, encoder: Encoder::LibWebp },
    FormatSpec { id: OutputFormat::Tiff, label: "TIFF", extensions: &["tiff", "tif"], mime: "image/tiff", lossy: false, alpha: true,  keeps_metadata: true,  encoder: image_io("public.tiff") },
    FormatSpec { id: OutputFormat::Gif,  label: "GIF",  extensions: &["gif"],         mime: "image/gif",  lossy: false, alpha: true,  keeps_metadata: false, encoder: image_io("com.compuserve.gif") },
    FormatSpec { id: OutputFormat::Bmp,  label: "BMP",  extensions: &["bmp"],         mime: "image/bmp",  lossy: false, alpha: false, keeps_metadata: false, encoder: image_io("com.microsoft.bmp") },
];

/// この OS で実際に書き出せる形式 (AVIF や HEIC は macOS のバージョンによって書けない)
fn available_formats() -> &'static [FormatSpec] {
    static AVAILABLE: OnceLock<Vec<FormatSpec>> = OnceLock::new();
    AVAILABLE.get_or_init(|| {
        let writable = engine::writable_type_identifiers();
        FORMATS
            .iter()
            .filter(|spec| match spec.encoder {
                Encoder::ImageIo { type_identifier } => {
                    writable.iter().any(|t| t == type_identifier)
                }
                Encoder::LibWebp => true,
            })
            .copied()
            .collect()
    })
}

fn format_spec(format: OutputFormat) -> Result<&'static FormatSpec, String> {
    available_formats()
        .iter()
        .find(|spec| spec.id == format)
        .ok_or_else(|| format!("この macOS では {format:?} 形式に書き出せません"))
}

/// 読み込んだ画像の形式名 (Uniform Type Identifier → 表示名)
fn source_format_label(type_identifier: &str) -> String {
    const KNOWN: &[(&str, &str)] = &[
        ("public.jpeg", "JPEG"),
        ("public.png", "PNG"),
        ("public.heic", "HEIC"),
        ("public.heif", "HEIF"),
        ("public.avif", "AVIF"),
        ("org.webmproject.webp", "WebP"),
        ("public.tiff", "TIFF"),
        ("com.compuserve.gif", "GIF"),
        ("com.microsoft.bmp", "BMP"),
        ("public.jpeg-2000", "JPEG 2000"),
        ("public.jpeg-xl", "JPEG XL"),
        ("com.adobe.photoshop-image", "PSD"),
        ("com.adobe.raw-image", "DNG"),
        ("com.microsoft.ico", "ICO"),
    ];
    KNOWN
        .iter()
        .find(|(uti, _)| *uti == type_identifier)
        .map(|(_, label)| label.to_string())
        .unwrap_or_else(|| {
            if type_identifier.contains("raw-image") {
                "RAW".to_string()
            } else {
                type_identifier.to_string()
            }
        })
}

// ── 変換オプション ───────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resize {
    None,
    /// 長辺をこのピクセル数以下にする
    LongEdge {
        pixels: u32,
    },
    /// 元の大きさに対する割合 (1〜100)
    Percent {
        percent: u32,
    },
}

impl Resize {
    /// 元の長辺から、書き出す長辺を求める。拡大はしない。
    fn long_edge(self, original: u32) -> u32 {
        let edge = match self {
            Resize::None => original,
            Resize::LongEdge { pixels } => pixels,
            Resize::Percent { percent } => {
                (u64::from(original) * u64::from(percent.min(100)) / 100) as u32
            }
        };
        edge.clamp(1, original.max(1))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataPolicy {
    Keep,
    /// GPS 位置情報だけを除く
    StripLocation,
    StripAll,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvertOptions {
    pub format: OutputFormat,
    /// 1〜100。非可逆形式でだけ使う
    pub quality: u8,
    /// 指定すると、このバイト数以下に収まる最高の品質を探す。足りなければ縮小する
    pub target_bytes: Option<u64>,
    pub resize: Resize,
    pub metadata: MetadataPolicy,
}

// ── 変換 ────────────────────────────────────────────────

pub struct Encoded {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// 実際に使った品質 (可逆形式では None)
    pub quality: Option<u8>,
}

fn open_source(path: &Path) -> Result<Source, String> {
    crate::utils::require_extension(path, crate::IMAGE_EXTENSIONS)?;
    let size = crate::utils::assert_regular_file(path)?;
    if size > MAX_IMAGE_FILE_SIZE {
        return Err(format!("画像が大きすぎます: {size} bytes (上限 1 GB)"));
    }
    let source = engine::open(path)?;
    let pixels = u64::from(source.info.width) * u64::from(source.info.height);
    if pixels > MAX_IMAGE_PIXELS {
        return Err(format!(
            "画像の寸法が大きすぎます: {}×{} (上限 {} メガピクセル)",
            source.info.width,
            source.info.height,
            MAX_IMAGE_PIXELS / 1_000_000
        ));
    }
    Ok(source)
}

fn encode_webp(rendered: &Rendered, quality: u8) -> Result<Vec<u8>, String> {
    if rendered.width > WEBP_MAX_EDGE || rendered.height > WEBP_MAX_EDGE {
        return Err(format!(
            "WebP は一辺 {WEBP_MAX_EDGE}px までです。リサイズを指定してください"
        ));
    }
    let rgba = rendered.to_rgba()?;
    let encoder = webp::Encoder::from_rgba(&rgba, rendered.width, rendered.height);
    Ok(encoder.encode(f32::from(quality)).to_vec())
}

fn encode_once(
    source: &Source,
    rendered: &Rendered,
    spec: &FormatSpec,
    quality: u8,
    policy: MetadataPolicy,
) -> Result<Vec<u8>, String> {
    match spec.encoder {
        Encoder::LibWebp => encode_webp(rendered, quality),
        Encoder::ImageIo { type_identifier } => {
            let metadata = match policy {
                _ if !spec.keeps_metadata => Metadata::None,
                MetadataPolicy::StripAll => Metadata::None,
                MetadataPolicy::Keep => Metadata::From {
                    source,
                    keep_location: true,
                },
                MetadataPolicy::StripLocation => Metadata::From {
                    source,
                    keep_location: false,
                },
            };
            let quality = spec.lossy.then(|| f64::from(quality) / 100.0);
            rendered.encode(type_identifier, quality, metadata)
        }
    }
}

const QUALITY_STEP: u8 = 5;
const QUALITY_STEPS: u8 = 19; // 5, 10, ..., 95

/// `target` バイト以下に収まる最高の品質を二分探索で探す (品質が上がるとサイズも増える前提)。
/// どの品質でも収まらなければ最低品質の結果を返す。
fn best_quality_within(
    target: u64,
    mut encode: impl FnMut(u8) -> Result<Vec<u8>, String>,
) -> Result<(u8, Vec<u8>), String> {
    let quality_at = |step: u8| (step + 1) * QUALITY_STEP;
    let (mut low, mut high) = (0u8, QUALITY_STEPS);
    let mut best: Option<(u8, Vec<u8>)> = None;
    let mut smallest: Option<(u8, Vec<u8>)> = None;
    while low < high {
        let step = low + (high - low) / 2;
        let quality = quality_at(step);
        let bytes = encode(quality)?;
        if bytes.len() as u64 <= target {
            best = Some((quality, bytes));
            low = step + 1;
        } else {
            if step == 0 {
                smallest = Some((quality, bytes));
            }
            high = step;
        }
    }
    match best.or(smallest) {
        Some(found) => Ok(found),
        None => {
            let quality = quality_at(0);
            Ok((quality, encode(quality)?))
        }
    }
}

const MIN_TARGET_EDGE: u32 = 64;
const MAX_SHRINK_ROUNDS: usize = 6;

pub fn convert(path: &Path, options: &ConvertOptions) -> Result<Encoded, String> {
    let spec = format_spec(options.format)?;
    let source = open_source(path)?;
    let quality = options.quality.clamp(1, 100);
    let mut edge = options
        .resize
        .long_edge(source.info.width.max(source.info.height));

    for round in 0.. {
        let rendered = source.render(edge)?;
        let (used_quality, bytes) = match options.target_bytes {
            Some(target) if spec.lossy => {
                let (q, bytes) = best_quality_within(target, |q| {
                    encode_once(&source, &rendered, spec, q, options.metadata)
                })?;
                (Some(q), bytes)
            }
            _ => (
                spec.lossy.then_some(quality),
                encode_once(&source, &rendered, spec, quality, options.metadata)?,
            ),
        };

        let over_target = options
            .target_bytes
            .is_some_and(|target| bytes.len() as u64 > target);
        if !over_target || edge <= MIN_TARGET_EDGE || round >= MAX_SHRINK_ROUNDS {
            return Ok(Encoded {
                bytes,
                width: rendered.width,
                height: rendered.height,
                quality: used_quality,
            });
        }
        // 最低品質でも収まらないので縮小する。サイズは面積にほぼ比例するとみなして縮小率を決める
        let target = options.target_bytes.unwrap_or(0) as f64;
        let scale = (target / bytes.len() as f64).sqrt() * 0.9;
        edge = ((f64::from(edge) * scale) as u32).clamp(MIN_TARGET_EDGE, edge - 1);
    }
    unreachable!("the loop returns once the target is met or the rounds run out")
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{};base64,{}",
        mime,
        general_purpose::STANDARD.encode(bytes)
    )
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

// ── 一括変換 ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct BatchItem {
    pub source: String,
    pub source_size: u64,
    pub output_path: Option<String>,
    pub size: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct BatchProgress<'a> {
    done: usize,
    total: usize,
    item: &'a BatchItem,
}

/// 既存のファイルも、同じ一括変換の他の出力も上書きしない出力先を確保する。
/// 空のファイルを排他的に作って場所を取るので、存在確認と確保の間に隙が無く、
/// 大文字小文字だけ違う名前 (macOS の既定のファイルシステムは区別しない) も衝突として扱われる。
fn reserve_output_path(dir: &Path, stem: &str, extension: &str) -> std::io::Result<PathBuf> {
    let mut n = 0u32;
    loop {
        let name = match n {
            0 => format!("{stem}.{extension}"),
            n => format!("{stem}-{n}.{extension}"),
        };
        let candidate = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e),
        }
    }
}

fn convert_to_file(
    source: &Path,
    output: &Path,
    options: &ConvertOptions,
) -> Result<Encoded, String> {
    let encoded = crate::utils::catch_panic(|| convert(source, options))?;
    crate::utils::atomic_write(output, &encoded.bytes).map_err(|e| e.to_string())?;
    Ok(encoded)
}

/// `paths` を同じ設定で変換して `output_dir` に書き出す。1 件終わるたびに `on_done` を呼ぶ。
/// 失敗したファイルは結果に理由を入れ、残りの変換は続ける。
pub fn convert_batch(
    paths: &[String],
    output_dir: &Path,
    options: &ConvertOptions,
    mut on_done: impl FnMut(usize, &BatchItem),
) -> Result<Vec<BatchItem>, String> {
    let spec = format_spec(options.format)?;
    if !output_dir.is_dir() {
        return Err(format!(
            "保存先フォルダがありません: {}",
            output_dir.display()
        ));
    }
    if paths.len() > MAX_BATCH_FILES {
        return Err(format!(
            "一度に変換できるのは {MAX_BATCH_FILES} ファイルまでです"
        ));
    }

    // 出力先はファイル順に確保しておく (並列に処理しても結果の名前が変わらない)
    let mut outputs: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for p in paths {
        let stem = Path::new(p)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("image");
        match reserve_output_path(output_dir, stem, spec.extensions[0]) {
            Ok(path) => outputs.push(path),
            Err(e) => {
                outputs
                    .iter()
                    .for_each(|reserved| drop(std::fs::remove_file(reserved)));
                return Err(format!("保存先に書き込めません: {e}"));
            }
        }
    }

    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .min(4);
    let (tx, rx) = mpsc::channel::<(usize, BatchItem)>();
    let mut results: Vec<Option<BatchItem>> = vec![None; paths.len()];

    std::thread::scope(|scope| {
        for _ in 0..workers.min(paths.len()) {
            let tx = tx.clone();
            let (next, outputs) = (&next, &outputs);
            scope.spawn(move || loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(source) = paths.get(i) else { break };
                let source_size = std::fs::metadata(source).map(|m| m.len()).unwrap_or(0);
                let item = match convert_to_file(Path::new(source), &outputs[i], options) {
                    Ok(encoded) => BatchItem {
                        source: source.clone(),
                        source_size,
                        output_path: Some(outputs[i].to_string_lossy().into_owned()),
                        size: Some(encoded.bytes.len() as u64),
                        error: None,
                    },
                    Err(error) => {
                        // 確保しておいた空のファイルを残さない
                        let _ = std::fs::remove_file(&outputs[i]);
                        BatchItem {
                            source: source.clone(),
                            source_size,
                            output_path: None,
                            size: None,
                            error: Some(error),
                        }
                    }
                };
                if tx.send((i, item)).is_err() {
                    break;
                }
            });
        }
        drop(tx);
        for (done, (i, item)) in rx.iter().enumerate() {
            on_done(done + 1, &item);
            results[i] = Some(item);
        }
    });

    Ok(results.into_iter().flatten().collect())
}

// ── Tauri コマンド ────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub frame_count: usize,
    pub has_alpha: bool,
    pub has_gps: bool,
    pub file_size: u64,
}

#[derive(Debug, Serialize)]
pub struct Estimate {
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub quality: Option<u8>,
    /// 変換後の画像そのもの (data URL)。要求されなかった場合と大きすぎる場合は None
    pub preview: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Converted {
    pub output_path: String,
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub quality: Option<u8>,
}

#[tauri::command(async)]
pub fn list_image_formats() -> Vec<FormatSpec> {
    available_formats().to_vec()
}

#[tauri::command(async)]
pub fn read_image_info(path: String) -> Result<ImageInfo, String> {
    crate::utils::catch_panic(move || {
        let source = open_source(Path::new(&path))?;
        let info = &source.info;
        Ok(ImageInfo {
            width: info.width,
            height: info.height,
            format: source_format_label(&info.type_identifier),
            frame_count: info.frame_count,
            has_alpha: info.has_alpha,
            has_gps: info.has_gps,
            file_size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        })
    })
}

/// 表示用の画像を data URL で返す。HEIC や RAW など webview が直接表示できない形式も
/// 表示できるよう、長辺 `max_edge` 以下の JPEG (透過があれば PNG) に描き直す。
#[tauri::command(async)]
pub fn read_image_preview(path: String, max_edge: u32) -> Result<String, String> {
    crate::utils::catch_panic(move || {
        let source = open_source(Path::new(&path))?;
        let rendered = source.render(max_edge.clamp(16, 8192))?;
        if source.info.has_alpha {
            let png = rendered.encode("public.png", None, Metadata::None)?;
            Ok(data_url("image/png", &png))
        } else {
            let jpeg = rendered.encode("public.jpeg", Some(0.9), Metadata::None)?;
            Ok(data_url("image/jpeg", &jpeg))
        }
    })
}

/// 保存せずに変換だけ行い、変換後のサイズなどを返す。
#[tauri::command(async)]
pub fn estimate_image(
    path: String,
    options: ConvertOptions,
    with_preview: bool,
) -> Result<Estimate, String> {
    crate::utils::catch_panic(move || {
        let encoded = convert(Path::new(&path), &options)?;
        let spec = format_spec(options.format)?;
        let preview = (with_preview && encoded.bytes.len() <= MAX_RESULT_PREVIEW_BYTES)
            .then(|| data_url(spec.mime, &encoded.bytes));
        Ok(Estimate {
            size: encoded.bytes.len() as u64,
            width: encoded.width,
            height: encoded.height,
            quality: encoded.quality,
            preview,
        })
    })
}

#[tauri::command(async)]
pub fn convert_image(
    path: String,
    output_path: String,
    options: ConvertOptions,
) -> Result<Converted, String> {
    let (source, output) = (Path::new(&path), Path::new(&output_path));
    let spec = format_spec(options.format)?;
    crate::utils::require_extension(output, spec.extensions)?;
    // 保存はシンボリックリンクの先を置き換えるので、リンク先も同じ形式の拡張子でなければ書かない
    if let Ok(resolved) = std::fs::canonicalize(output) {
        crate::utils::require_extension(&resolved, spec.extensions)?;
    }
    if same_file(source, output) {
        return Err("元のファイルには上書きできません。別の名前で保存してください".to_string());
    }
    let encoded = convert_to_file(source, output, &options)?;
    Ok(Converted {
        output_path,
        size: encoded.bytes.len() as u64,
        width: encoded.width,
        height: encoded.height,
        quality: encoded.quality,
    })
}

#[tauri::command(async)]
pub fn convert_images(
    app: tauri::AppHandle,
    paths: Vec<String>,
    output_dir: String,
    options: ConvertOptions,
) -> Result<Vec<BatchItem>, String> {
    let total = paths.len();
    convert_batch(&paths, Path::new(&output_dir), &options, |done, item| {
        let _ = app.emit(
            "image-convert-progress",
            BatchProgress { done, total, item },
        );
    })
}

// ── テスト ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_engine::test_support::{
        camera_make, encode_with_camera_metadata, exif_pixel_size,
    };

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("qv_image_{}_{}", name, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 写真のように圧縮しにくい画像 (なだらかな階調 + ノイズ) を PNG で作る
    fn write_photo(path: &Path, width: u32, height: u32) {
        let mut seed = 0x2545_F491u32;
        let img = image::RgbImage::from_fn(width, height, |x, y| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let noise = (seed & 0x3F) as u8;
            image::Rgb([
                (x * 255 / width) as u8 ^ noise,
                (y * 255 / height) as u8 ^ noise,
                128 ^ noise,
            ])
        });
        img.save(path).unwrap();
    }

    fn options(format: OutputFormat) -> ConvertOptions {
        ConvertOptions {
            format,
            quality: 80,
            target_bytes: None,
            resize: Resize::None,
            metadata: MetadataPolicy::Keep,
        }
    }

    fn convert_file(source: &Path, output: &Path, options: &ConvertOptions) -> Converted {
        convert_image(
            source.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),
            options.clone(),
        )
        .unwrap()
    }

    fn size_of(source: &Path, options: &ConvertOptions) -> (usize, u32, u32) {
        let e = convert(source, options).unwrap();
        (e.bytes.len(), e.width, e.height)
    }

    #[test]
    fn heic_is_written_read_back_and_converted_to_jpeg() {
        let dir = TempDir::new("heic");
        let (png, heic, jpg) = (
            dir.path("photo.png"),
            dir.path("photo.heic"),
            dir.path("photo.jpg"),
        );
        write_photo(&png, 320, 200);

        convert_file(&png, &heic, &options(OutputFormat::Heic));
        let info = read_image_info(heic.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            (info.width, info.height, info.format.as_str()),
            (320, 200, "HEIC")
        );

        let converted = convert_file(&heic, &jpg, &options(OutputFormat::Jpeg));
        let bytes = std::fs::read(&jpg).unwrap();
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF]);
        assert_eq!((converted.width, converted.height), (320, 200));
        assert_eq!(converted.size, bytes.len() as u64);
    }

    #[test]
    fn every_listed_format_produces_a_file_the_os_can_read() {
        let dir = TempDir::new("formats");
        let png = dir.path("src.png");
        write_photo(&png, 64, 48);
        let formats = list_image_formats();
        assert!(formats.iter().any(|f| f.id == OutputFormat::Jpeg));
        assert!(formats.iter().any(|f| f.id == OutputFormat::Webp));
        for spec in formats {
            let out = dir.path(&format!("out.{}", spec.extensions[0]));
            convert_file(&png, &out, &options(spec.id));
            let info = engine::open(&out)
                .unwrap_or_else(|e| panic!("{}: {e}", spec.label))
                .info;
            assert_eq!((info.width, info.height), (64, 48), "{}", spec.label);
        }
    }

    #[test]
    fn lower_quality_makes_a_smaller_file() {
        let dir = TempDir::new("quality");
        let png = dir.path("src.png");
        write_photo(&png, 400, 300);
        for format in [OutputFormat::Jpeg, OutputFormat::Heic, OutputFormat::Webp] {
            let low = size_of(
                &png,
                &ConvertOptions {
                    quality: 30,
                    ..options(format)
                },
            )
            .0;
            let high = size_of(
                &png,
                &ConvertOptions {
                    quality: 90,
                    ..options(format)
                },
            )
            .0;
            assert!(low < high, "{format:?}: q30={low} q90={high}");
        }
    }

    #[test]
    fn resize_scales_the_long_edge_and_never_upscales() {
        let dir = TempDir::new("resize");
        let png = dir.path("src.png");
        write_photo(&png, 400, 200);
        let dims = |resize| {
            let (_, w, h) = size_of(
                &png,
                &ConvertOptions {
                    resize,
                    ..options(OutputFormat::Jpeg)
                },
            );
            (w, h)
        };
        assert_eq!(dims(Resize::LongEdge { pixels: 100 }), (100, 50));
        assert_eq!(dims(Resize::Percent { percent: 50 }), (200, 100));
        assert_eq!(dims(Resize::LongEdge { pixels: 9_999 }), (400, 200));
        assert_eq!(dims(Resize::None), (400, 200));
    }

    #[test]
    fn target_size_picks_the_best_quality_that_fits_then_shrinks() {
        let dir = TempDir::new("target");
        let png = dir.path("src.png");
        write_photo(&png, 600, 400);
        let with_target = |target| {
            convert(
                &png,
                &ConvertOptions {
                    target_bytes: Some(target),
                    ..options(OutputFormat::Jpeg)
                },
            )
            .unwrap()
        };

        let at_q95 = size_of(
            &png,
            &ConvertOptions {
                quality: 95,
                ..options(OutputFormat::Jpeg)
            },
        )
        .0 as u64;
        let roomy = with_target(at_q95 / 2);
        assert!(roomy.bytes.len() as u64 <= at_q95 / 2);
        assert_eq!(
            (roomy.width, roomy.height),
            (600, 400),
            "quality alone should be enough"
        );
        assert!(roomy.quality.unwrap() < 95);

        // 最低品質でも収まらない大きさを指定すると、画像を縮小して収める
        let tight = with_target(3_000);
        assert!(
            tight.bytes.len() <= 3_000,
            "got {} bytes",
            tight.bytes.len()
        );
        assert!(tight.width < 600);
    }

    #[test]
    fn best_quality_within_finds_the_highest_fitting_step() {
        let sized = |q: u8| Ok(vec![0u8; usize::from(q) * 100]);
        assert_eq!(best_quality_within(5_050, sized).unwrap().0, 50);
        assert_eq!(best_quality_within(1_000_000, sized).unwrap().0, 95);
        // どの品質でも収まらないときは最低品質の結果を返す
        let (q, bytes) = best_quality_within(10, sized).unwrap();
        assert_eq!((q, bytes.len()), (5, 500));
    }

    /// 向き 6 (90 度回転) と GPS・メーカー名を持つ 40x20 の JPEG
    fn write_camera_jpeg(dir: &TempDir) -> PathBuf {
        let png = dir.path("pixels.png");
        write_photo(&png, 40, 20);
        let rendered = engine::open(&png).unwrap().render(40).unwrap();
        let jpg = dir.path("camera.jpg");
        std::fs::write(
            &jpg,
            encode_with_camera_metadata(&rendered, "public.jpeg", 6),
        )
        .unwrap();
        jpg
    }

    #[test]
    fn rotated_photos_come_out_upright() {
        let dir = TempDir::new("orientation");
        let jpg = write_camera_jpeg(&dir);
        let info = engine::open(&jpg).unwrap().info;
        assert_eq!(
            (info.width, info.height),
            (20, 40),
            "display size follows the orientation tag"
        );

        let out = dir.path("upright.heic");
        let converted = convert_file(&jpg, &out, &options(OutputFormat::Heic));
        assert_eq!((converted.width, converted.height), (20, 40));
        // 画素を回転済みなので、向きのタグが残っていると二重に回転してしまう
        let reopened = engine::open(&out).unwrap().info;
        assert_eq!((reopened.width, reopened.height), (20, 40));
    }

    #[test]
    fn metadata_policies_control_location_and_exif() {
        let dir = TempDir::new("metadata");
        let jpg = write_camera_jpeg(&dir);
        let source = engine::open(&jpg).unwrap();
        assert!(source.info.has_gps);
        assert_eq!(camera_make(&source).as_deref(), Some("QuickViewTest"));

        let result = |policy, name: &str| {
            let out = dir.path(name);
            convert_file(
                &jpg,
                &out,
                &ConvertOptions {
                    metadata: policy,
                    ..options(OutputFormat::Jpeg)
                },
            );
            let s = engine::open(&out).unwrap();
            (s.info.has_gps, camera_make(&s))
        };
        assert_eq!(
            result(MetadataPolicy::Keep, "keep.jpg"),
            (true, Some("QuickViewTest".into()))
        );
        assert_eq!(
            result(MetadataPolicy::StripLocation, "noloc.jpg"),
            (false, Some("QuickViewTest".into()))
        );
        assert_eq!(result(MetadataPolicy::StripAll, "bare.jpg"), (false, None));
    }

    #[test]
    fn transparency_is_flattened_onto_white_for_formats_without_alpha() {
        let dir = TempDir::new("alpha");
        let png = dir.path("transparent.png");
        image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 0, 0, 0]))
            .save(&png)
            .unwrap();
        assert!(engine::open(&png).unwrap().info.has_alpha);

        let jpg = dir.path("flat.jpg");
        convert_file(
            &png,
            &jpg,
            &ConvertOptions {
                quality: 95,
                ..options(OutputFormat::Jpeg)
            },
        );
        let rgba = engine::open(&jpg)
            .unwrap()
            .render(16)
            .unwrap()
            .to_rgba()
            .unwrap();
        assert!(
            rgba[..3].iter().all(|&c| c > 240),
            "expected white, got {:?}",
            &rgba[..4]
        );

        // 透過を持てる形式ではそのまま残る
        let webp = dir.path("clear.webp");
        convert_file(&png, &webp, &options(OutputFormat::Webp));
        let rgba = engine::open(&webp)
            .unwrap()
            .render(16)
            .unwrap()
            .to_rgba()
            .unwrap();
        assert_eq!(rgba[3], 0);
    }

    #[test]
    fn preview_is_a_data_url_the_webview_can_show() {
        let dir = TempDir::new("preview");
        let (png, heic) = (dir.path("src.png"), dir.path("src.heic"));
        write_photo(&png, 300, 100);
        convert_file(&png, &heic, &options(OutputFormat::Heic));
        let preview = read_image_preview(heic.to_string_lossy().into_owned(), 64).unwrap();
        assert!(preview.starts_with("data:image/jpeg;base64,"));

        let estimate = estimate_image(
            heic.to_string_lossy().into_owned(),
            options(OutputFormat::Webp),
            true,
        )
        .unwrap();
        assert!(estimate
            .preview
            .unwrap()
            .starts_with("data:image/webp;base64,"));
        assert_eq!((estimate.width, estimate.height), (300, 100));
        let without = estimate_image(
            heic.to_string_lossy().into_owned(),
            options(OutputFormat::Webp),
            false,
        )
        .unwrap();
        assert!(without.preview.is_none());
        assert_eq!(without.size, estimate.size);
    }

    #[test]
    fn commands_refuse_other_file_types_and_overwriting_the_source() {
        let dir = TempDir::new("guards");
        let (secret, jpg) = (dir.path("id_rsa"), dir.path("a.jpg"));
        std::fs::write(&secret, "PRIVATE KEY").unwrap();
        write_photo(&dir.path("a.png"), 32, 32);
        convert_file(&dir.path("a.png"), &jpg, &options(OutputFormat::Jpeg));
        let s = |p: &Path| p.to_string_lossy().into_owned();

        assert!(read_image_info(s(&secret)).is_err());
        assert!(read_image_preview(s(&secret), 100).is_err());
        // 選んだ形式と違う拡張子には書かない
        assert!(convert_image(
            s(&jpg),
            s(&dir.path("out.plist")),
            options(OutputFormat::Jpeg)
        )
        .is_err());
        assert!(!dir.path("out.plist").exists());
        // 非可逆の再圧縮で元のファイルを壊さない
        let before = std::fs::read(&jpg).unwrap();
        assert!(convert_image(s(&jpg), s(&jpg), options(OutputFormat::Jpeg)).is_err());
        assert_eq!(std::fs::read(&jpg).unwrap(), before);
    }

    #[test]
    fn batch_keeps_both_files_when_names_differ_only_by_case() {
        let dir = TempDir::new("case");
        let out_dir = dir.path("out");
        for sub in ["a", "b", "out"] {
            std::fs::create_dir_all(dir.path(sub)).unwrap();
        }
        write_photo(&dir.path("a/Photo.png"), 80, 60);
        write_photo(&dir.path("b/photo.png"), 60, 80);
        let paths: Vec<String> = ["a/Photo.png", "b/photo.png"]
            .iter()
            .map(|p| dir.path(p).to_string_lossy().into_owned())
            .collect();

        let results =
            convert_batch(&paths, &out_dir, &options(OutputFormat::Jpeg), |_, _| {}).unwrap();

        // 大文字小文字を区別しないファイルシステムでは Photo.jpg と photo.jpg は同じファイルになる
        let widths: Vec<u32> = results
            .iter()
            .map(|r| {
                engine::open(Path::new(r.output_path.as_ref().unwrap()))
                    .unwrap()
                    .info
                    .width
            })
            .collect();
        assert_eq!(widths, vec![80, 60]);
        assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 2);
    }

    #[test]
    fn convert_image_does_not_write_through_a_symlink_to_another_kind_of_file() {
        let dir = TempDir::new("symlink");
        let (png, secret, link) = (
            dir.path("a.png"),
            dir.path("notes.txt"),
            dir.path("out.jpg"),
        );
        write_photo(&png, 32, 32);
        std::fs::write(&secret, "keep me").unwrap();
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();

        assert!(convert_image(s(&png), s(&link), options(OutputFormat::Jpeg)).is_err());
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "keep me");
    }

    #[test]
    fn resized_output_reports_its_real_size_in_exif() {
        let dir = TempDir::new("exifsize");
        let jpg = write_camera_jpeg(&dir);
        let out = dir.path("small.jpg");
        convert_file(
            &jpg,
            &out,
            &ConvertOptions {
                resize: Resize::LongEdge { pixels: 20 },
                ..options(OutputFormat::Jpeg)
            },
        );
        let source = engine::open(&out).unwrap();
        assert_eq!((source.info.width, source.info.height), (10, 20));
        // 元画像の Exif (40x20) をそのまま引き継ぐと古い寸法が残る。ImageIO が書き出し時に直す
        assert_eq!(
            exif_pixel_size(&engine::open(&jpg).unwrap()),
            Some((40, 20))
        );
        assert_eq!(exif_pixel_size(&source), Some((10, 20)));
    }

    #[test]
    fn images_with_huge_dimensions_are_refused_before_decoding() {
        // 2.56 億画素の 1bit PNG。ファイルは 31KB だが、展開には画素数に比例したメモリが要る
        // (4 億画素の同種のファイルで、表示用の展開だけで 450MB を計測)
        let png = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/huge-16000x16000.png");
        assert!(std::fs::metadata(&png).unwrap().len() < 100_000);

        let err = read_image_preview(png.to_string_lossy().into_owned(), 4096).unwrap_err();
        assert!(err.contains("寸法が大きすぎます"), "{err}");
        assert!(convert(&png, &options(OutputFormat::Jpeg)).is_err());
    }

    #[test]
    fn batch_converts_what_it_can_and_never_overwrites() {
        let dir = TempDir::new("batch");
        let out_dir = dir.path("out");
        std::fs::create_dir_all(dir.path("a")).unwrap();
        std::fs::create_dir_all(dir.path("b")).unwrap();
        std::fs::create_dir_all(&out_dir).unwrap();
        // 別フォルダの同名ファイル 2 つ、壊れたファイル 1 つ、保存先に既にある同名ファイル
        write_photo(&dir.path("a/photo.png"), 80, 60);
        write_photo(&dir.path("b/photo.png"), 60, 80);
        std::fs::write(dir.path("broken.jpg"), "not an image").unwrap();
        std::fs::write(out_dir.join("photo.jpg"), "existing").unwrap();
        let paths: Vec<String> = ["a/photo.png", "broken.jpg", "b/photo.png"]
            .iter()
            .map(|p| dir.path(p).to_string_lossy().into_owned())
            .collect();

        let mut progress = Vec::new();
        let results = convert_batch(&paths, &out_dir, &options(OutputFormat::Jpeg), |done, _| {
            progress.push(done)
        })
        .unwrap();

        assert_eq!(progress, vec![1, 2, 3]);
        let names: Vec<Option<String>> = results
            .iter()
            .map(|r| {
                r.output_path.as_ref().map(|p| {
                    Path::new(p)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
            })
            .collect();
        assert_eq!(
            names,
            vec![Some("photo-1.jpg".into()), None, Some("photo-2.jpg".into())]
        );
        assert!(results[1].error.is_some());
        assert!(
            !out_dir.join("broken.jpg").exists(),
            "a failed item must not leave a file behind"
        );
        assert!(results[0].size.unwrap() > 0 && results[0].source_size > 0);
        assert_eq!(
            std::fs::read(out_dir.join("photo.jpg")).unwrap(),
            b"existing"
        );
        assert_eq!(
            engine::open(&out_dir.join("photo-2.jpg"))
                .unwrap()
                .info
                .width,
            60
        );
    }
}
