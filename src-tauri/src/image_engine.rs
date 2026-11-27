//! macOS の ImageIO / CoreGraphics による画像の読み込み・描画・書き出し。
//! HEIC や RAW を含めて OS が読める形式をそのまま扱える。

use std::path::Path;

use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFMutableData, CFMutableDictionary, CFNumber, CFRetained, CFString,
    CFType, CGPoint, CGRect, CGSize, CFURL,
};
use objc2_core_graphics::{
    kCGColorSpaceSRGB, CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
};
use objc2_image_io::{
    kCGImageDestinationLossyCompressionQuality, kCGImagePropertyGPSDictionary,
    kCGImagePropertyHasAlpha, kCGImagePropertyOrientation, kCGImagePropertyPixelHeight,
    kCGImagePropertyPixelWidth, kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFOrientation,
    kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceThumbnailMaxPixelSize, CGImageDestination, CGImageSource,
};

type Properties = CFDictionary<CFString, CFType>;
type MutableProperties = CFMutableDictionary<CFString, CFType>;

fn typed(dict: &CFDictionary) -> &Properties {
    // SAFETY: ImageIO のプロパティ辞書はキーが CFString、値が CF オブジェクト
    unsafe { dict.cast_unchecked() }
}

fn number(dict: &Properties, key: &CFString) -> Option<i64> {
    dict.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
}

fn mutable_copy(dict: &CFDictionary) -> Result<CFRetained<MutableProperties>, String> {
    // SAFETY: 有効な辞書のコピーを作るだけで、型は typed() と同じ前提
    unsafe {
        CFMutableDictionary::new_copy(None, 0, Some(dict))
            .map(|copy| CFRetained::cast_unchecked(copy))
            .ok_or_else(|| "メタデータを複製できませんでした".to_string())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SourceInfo {
    /// 向き (EXIF Orientation) を反映した表示上の幅と高さ
    pub width: u32,
    pub height: u32,
    /// Uniform Type Identifier (例: public.heic)
    pub type_identifier: String,
    pub frame_count: usize,
    pub has_alpha: bool,
    pub has_gps: bool,
}

pub struct Source {
    source: CFRetained<CGImageSource>,
    /// 代表画像の位置 (HEIC は複数の画像を含められる)
    index: usize,
    properties: CFRetained<CFDictionary>,
    pub info: SourceInfo,
}

pub fn open(path: &Path) -> Result<Source, String> {
    let unreadable = || format!("画像として読み込めません: {}", path.display());
    let url = CFURL::from_file_path(path).ok_or_else(unreadable)?;
    // SAFETY: url は有効で、options は None
    let source = unsafe { CGImageSource::with_url(&url, None) }.ok_or_else(unreadable)?;
    let frame_count = unsafe { source.count() };
    let index = unsafe { source.primary_image_index() };
    let properties = unsafe { source.properties_at_index(index, None) }.ok_or_else(unreadable)?;

    let props = typed(&properties);
    // SAFETY: ImageIO が公開している定数キー
    let (width_key, height_key, orientation_key, alpha_key, gps_key) = unsafe {
        (
            kCGImagePropertyPixelWidth,
            kCGImagePropertyPixelHeight,
            kCGImagePropertyOrientation,
            kCGImagePropertyHasAlpha,
            kCGImagePropertyGPSDictionary,
        )
    };
    let stored_width = number(props, width_key).unwrap_or(0);
    let stored_height = number(props, height_key).unwrap_or(0);
    if frame_count == 0 || stored_width <= 0 || stored_height <= 0 {
        return Err(unreadable());
    }
    // Orientation 5〜8 は 90 度回転して保存されている
    let rotated = number(props, orientation_key).is_some_and(|o| (5..=8).contains(&o));
    let (width, height) = if rotated {
        (stored_height, stored_width)
    } else {
        (stored_width, stored_height)
    };
    let has_alpha = props
        .get(alpha_key)
        .and_then(|v| v.downcast::<CFBoolean>().ok())
        .is_some_and(|b| b.as_bool());
    let info = SourceInfo {
        width: width as u32,
        height: height as u32,
        type_identifier: unsafe { source.r#type() }
            .map(|t| t.to_string())
            .unwrap_or_default(),
        frame_count,
        has_alpha,
        has_gps: props.contains_key(gps_key),
    };
    Ok(Source {
        source,
        index,
        properties,
        info,
    })
}

/// 向きを反映し、指定の大きさに縮小した画素
pub struct Rendered {
    image: CFRetained<CGImage>,
    pub width: u32,
    pub height: u32,
}

impl Source {
    /// 長辺が `max_edge` 以下になるように描画する (拡大はしない)。
    pub fn render(&self, max_edge: u32) -> Result<Rendered, String> {
        let edge = max_edge.clamp(1, self.info.width.max(self.info.height));
        let options = MutableProperties::empty();
        // SAFETY: ImageIO が公開している定数キー
        unsafe {
            // 埋め込みサムネイルではなく本体の画素から作り、EXIF の向きを画素に反映する
            options.set(
                kCGImageSourceCreateThumbnailFromImageAlways,
                CFBoolean::new(true),
            );
            options.set(
                kCGImageSourceCreateThumbnailWithTransform,
                CFBoolean::new(true),
            );
            options.set(
                kCGImageSourceThumbnailMaxPixelSize,
                &CFNumber::new_i64(i64::from(edge)),
            );
        }
        // SAFETY: options は上で作った有効な辞書
        let image = unsafe {
            self.source
                .thumbnail_at_index(self.index, Some(options.as_opaque()))
        }
        .ok_or_else(|| "画像を展開できませんでした".to_string())?;
        let width = CGImage::width(Some(&image)) as u32;
        let height = CGImage::height(Some(&image)) as u32;
        Ok(Rendered {
            image,
            width,
            height,
        })
    }

    /// 書き出し先に引き継ぐメタデータ。画素は向きを反映済みなので Orientation は 1 に戻す。
    fn metadata(&self, keep_location: bool) -> Result<CFRetained<MutableProperties>, String> {
        let props = mutable_copy(&self.properties)?;
        let upright = CFNumber::new_i64(1);
        // SAFETY: ImageIO が公開している定数キー
        unsafe {
            props.set(kCGImagePropertyOrientation, &upright);
            if let Some(tiff) = props
                .get(kCGImagePropertyTIFFDictionary)
                .and_then(|v| v.downcast::<CFDictionary>().ok())
            {
                let tiff = mutable_copy(&tiff)?;
                tiff.set(kCGImagePropertyTIFFOrientation, &upright);
                props.set(kCGImagePropertyTIFFDictionary, tiff.as_opaque());
            }
            if !keep_location {
                props.remove(kCGImagePropertyGPSDictionary);
            }
        }
        Ok(props)
    }
}

pub enum Metadata<'a> {
    /// 何も引き継がない
    None,
    /// 元画像の EXIF などを引き継ぐ。`keep_location` が false なら GPS 位置情報だけ除く
    From {
        source: &'a Source,
        keep_location: bool,
    },
}

/// ImageIO が書き出せる形式の Uniform Type Identifier 一覧
pub fn writable_type_identifiers() -> Vec<String> {
    // SAFETY: 引数なしで CFString の配列を返す
    let types = unsafe { CGImageDestination::type_identifiers() };
    // SAFETY: 要素は CFString
    let types = unsafe { types.cast_unchecked::<CFString>() };
    types.to_vec().iter().map(|t| t.to_string()).collect()
}

impl Rendered {
    /// ImageIO で `type_identifier` の形式に書き出す。
    /// `quality` は 0.0〜1.0 (非可逆形式のみ)。
    /// 透過を持てない形式では ImageIO が白背景に合成する。
    pub fn encode(
        &self,
        type_identifier: &str,
        quality: Option<f64>,
        metadata: Metadata,
    ) -> Result<Vec<u8>, String> {
        let failed = || format!("{type_identifier} への書き出しに失敗しました");
        let data = CFMutableData::new(None, 0).ok_or_else(failed)?;
        // SAFETY: data と type は有効で、画像は 1 枚
        let destination = unsafe {
            CGImageDestination::with_data(&data, &CFString::from_str(type_identifier), 1, None)
        }
        .ok_or_else(failed)?;

        let props = match metadata {
            Metadata::None => MutableProperties::empty(),
            Metadata::From {
                source,
                keep_location,
            } => source.metadata(keep_location)?,
        };
        // SAFETY: ImageIO が公開している定数キー
        unsafe {
            if let Some(q) = quality {
                props.set(
                    kCGImageDestinationLossyCompressionQuality,
                    &CFNumber::new_f64(q.clamp(0.0, 1.0)),
                );
            }
            destination.add_image(&self.image, Some(props.as_opaque()));
            if !destination.finalize() {
                return Err(failed());
            }
        }
        Ok(data.to_vec())
    }

    /// sRGB の RGBA (アルファは乗算なし) に展開する。ImageIO が書けない形式のエンコーダに渡す。
    pub fn to_rgba(&self) -> Result<Vec<u8>, String> {
        let (width, height) = (self.width as usize, self.height as usize);
        let failed = || "画素を取り出せませんでした".to_string();
        let mut pixels = vec![0u8; width * height * 4];
        // SAFETY: ImageIO が公開している定数
        let srgb =
            CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB })).ok_or_else(failed)?;
        // SAFETY: pixels は width*height*4 バイトで、コンテキストより長く生存する
        let context = unsafe {
            CGBitmapContextCreate(
                pixels.as_mut_ptr().cast(),
                width,
                height,
                8,
                width * 4,
                Some(&srgb),
                CGImageAlphaInfo::PremultipliedLast.0,
            )
        }
        .ok_or_else(failed)?;
        let bounds = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize {
                width: width as f64,
                height: height as f64,
            },
        };
        CGContext::draw_image(Some(&context), bounds, Some(&self.image));
        drop(context);

        for px in pixels.as_chunks_mut::<4>().0 {
            let alpha = u32::from(px[3]);
            if alpha != 0 && alpha != 255 {
                for c in &mut px[..3] {
                    *c = ((u32::from(*c) * 255 + alpha / 2) / alpha).min(255) as u8;
                }
            }
        }
        Ok(pixels)
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use objc2_image_io::{
        kCGImagePropertyExifDictionary, kCGImagePropertyExifPixelXDimension,
        kCGImagePropertyExifPixelYDimension, kCGImagePropertyGPSLatitude,
        kCGImagePropertyGPSLatitudeRef, kCGImagePropertyTIFFMake,
    };

    /// 撮影時の向きと位置情報・メーカー名を持つファイルを作る (メタデータ処理のテスト用)。
    pub fn encode_with_camera_metadata(
        rendered: &Rendered,
        type_identifier: &str,
        orientation: i64,
    ) -> Vec<u8> {
        let data = CFMutableData::new(None, 0).unwrap();
        let props = MutableProperties::empty();
        let gps = MutableProperties::empty();
        let tiff = MutableProperties::empty();
        unsafe {
            let destination =
                CGImageDestination::with_data(&data, &CFString::from_str(type_identifier), 1, None)
                    .unwrap();
            gps.set(kCGImagePropertyGPSLatitude, &CFNumber::new_f64(35.6812));
            gps.set(kCGImagePropertyGPSLatitudeRef, &CFString::from_str("N"));
            tiff.set(
                kCGImagePropertyTIFFMake,
                &CFString::from_str("QuickViewTest"),
            );
            props.set(kCGImagePropertyGPSDictionary, gps.as_opaque());
            props.set(kCGImagePropertyTIFFDictionary, tiff.as_opaque());
            props.set(kCGImagePropertyOrientation, &CFNumber::new_i64(orientation));
            destination.add_image(&rendered.image, Some(props.as_opaque()));
            assert!(destination.finalize());
        }
        data.to_vec()
    }

    pub fn exif_pixel_size(source: &Source) -> Option<(i64, i64)> {
        let props = typed(&source.properties);
        unsafe {
            let exif = props
                .get(kCGImagePropertyExifDictionary)?
                .downcast::<CFDictionary>()
                .ok()?;
            let exif = typed(&exif);
            Some((
                number(exif, kCGImagePropertyExifPixelXDimension)?,
                number(exif, kCGImagePropertyExifPixelYDimension)?,
            ))
        }
    }

    pub fn camera_make(source: &Source) -> Option<String> {
        let props = typed(&source.properties);
        unsafe {
            let tiff = props
                .get(kCGImagePropertyTIFFDictionary)?
                .downcast::<CFDictionary>()
                .ok()?;
            let make = typed(&tiff).get(kCGImagePropertyTIFFMake)?;
            Some(make.downcast::<CFString>().ok()?.to_string())
        }
    }
}
