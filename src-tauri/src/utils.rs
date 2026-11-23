use chardetng::EncodingDetector;
use std::io::Write;
use std::path::Path;

/// ファイルバイト列をエンコーディング自動検出してデコードし、(テキスト, エンコーディング名) を返す。
pub fn decode_file(raw: &[u8]) -> (String, String) {
    // UTF-8 BOM を除去してからデコード
    let raw = raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(raw);

    let mut detector = EncodingDetector::new();
    detector.feed(raw, true);
    let encoding = detector.guess(None, true);
    let (cow, _, _) = encoding.decode(raw);
    (cow.into_owned(), encoding.name().to_string())
}

/// テキストを指定エンコーディングでエンコードする。不明なラベルは UTF-8 にフォールバック。
pub fn encode_file(content: &str, encoding_name: &str) -> Vec<u8> {
    let encoding =
        encoding_rs::Encoding::for_label(encoding_name.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (bytes, _, _) = encoding.encode(content);
    bytes.into_owned()
}

/// temp file → sync → rename パターンのアトミック書込。
/// 中断・ディスクフルによるゼロバイト化を防ぐ。
/// 内部データ（設定・注釈など）向け。パーミッション継承や symlink 解決は行わない。
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    atomic_write_inner(path, data, None)
}

/// 利用者ファイル向けアトミック書込。
/// - 既存パスは `canonicalize` で実体を解決し、symlink を実ファイルに置き換えない
/// - 既存ファイルのパーミッションを一時ファイルへコピーする
/// - 失敗時は一時ファイルを削除する
pub fn atomic_write_user_file(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let target = if path.exists() {
        std::fs::canonicalize(path)?
    } else {
        path.to_path_buf()
    };
    let perms = if target.exists() {
        Some(std::fs::metadata(&target)?.permissions())
    } else {
        None
    };
    let result = atomic_write_inner(&target, data, perms.as_ref());
    result
}

fn atomic_write_inner(
    path: &Path,
    data: &[u8],
    perms: Option<&std::fs::Permissions>,
) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let fname = path.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no filename")
    })?;
    let mut tmp_name = fname.to_os_string();
    tmp_name.push(format!(".{}.tmp", std::process::id()));
    let tmp_path = parent.join(tmp_name);

    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        if let Some(p) = perms {
            std::fs::set_permissions(&tmp_path, p.clone())?;
        }
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    };

    match write() {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

/// ファイルが通常ファイルであることを確認する (FIFO / device / symlink→device を拒否)。
/// symlink → regular file は許可する。
pub fn assert_regular_file(path: &Path) -> Result<u64, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("Not a regular file: {}", path.display()));
    }
    Ok(meta.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::SHIFT_JIS;
    use std::fs;

    #[test]
    fn decode_file_utf8() {
        let data = b"hello, world";
        let (decoded, encoding) = decode_file(data);
        assert_eq!(decoded, "hello, world");
        assert!(!encoding.is_empty());
    }

    #[test]
    fn decode_file_shift_jis() {
        let unicode = "日本語テスト";
        let (encoded, _, _) = SHIFT_JIS.encode(unicode);
        let (decoded, enc) = decode_file(&encoded);
        assert!(
            decoded.contains("日本語"),
            "expected SJIS decode, got encoding={enc} content={decoded:?}"
        );
    }

    #[test]
    fn encode_file_shift_jis_roundtrip() {
        let text = "# 見出し\n本文";
        let bytes = encode_file(text, "Shift_JIS");
        let (decoded, _, had_errors) = SHIFT_JIS.decode(&bytes);
        assert!(!had_errors);
        assert_eq!(decoded, text);
    }

    #[test]
    fn atomic_write_creates_file() {
        let dir = std::env::temp_dir();
        let path = dir.join("qv_atomic_test.txt");
        atomic_write(&path, b"hello").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn atomic_write_overwrites_existing() {
        let dir = std::env::temp_dir();
        let path = dir.join("qv_atomic_overwrite.txt");
        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        fs::remove_file(&path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_user_file_preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir();
        let path = dir.join(format!("qv_perms_{}.md", std::process::id()));
        fs::write(&path, b"old").unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&path, perms).unwrap();

        atomic_write_user_file(&path, b"new").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected mode 600, got {mode:o}");
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_file(&path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_user_file_updates_symlink_target() {
        let dir = std::env::temp_dir();
        let target = dir.join(format!("qv_symlink_target_{}.md", std::process::id()));
        let link = dir.join(format!("qv_symlink_link_{}.md", std::process::id()));
        fs::write(&target, b"old").unwrap();
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();

        atomic_write_user_file(&link, b"updated").unwrap();

        assert!(
            fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
            "symlink should remain a symlink"
        );
        assert_eq!(fs::read(&target).unwrap(), b"updated");
        assert_eq!(fs::read(&link).unwrap(), b"updated");
        fs::remove_file(&link).ok();
        fs::remove_file(&target).ok();
    }

    #[test]
    fn atomic_write_user_file_creates_missing() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("qv_user_create_{}.md", std::process::id()));
        let _ = fs::remove_file(&path);
        atomic_write_user_file(&path, b"hello").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn assert_regular_file_accepts_regular() {
        let dir = std::env::temp_dir();
        let path = dir.join("qv_regular_test.txt");
        fs::write(&path, b"x").unwrap();
        assert!(assert_regular_file(&path).is_ok());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn assert_regular_file_rejects_directory() {
        let dir = std::env::temp_dir();
        assert!(assert_regular_file(&dir).is_err());
    }
}
