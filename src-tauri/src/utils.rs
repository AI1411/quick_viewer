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
///
/// - path がシンボリックリンクなら、リンク自体ではなくリンク先を置き換える
/// - 既存ファイルのパーミッションを引き継ぐ (0600 の秘密ファイルが 0644 にならない)
/// - 一時ファイルは推測しにくい名前で排他的に作る (既存のファイルやリンクを辿らない)
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    atomic_write_with(path, |file| file.write_all(data))
}

/// 利用者のファイル (Markdown など) を保存する。atomic_write がすでにリンク先の解決と
/// パーミッションの維持を行うので、同じ手順で書き込む。
pub fn atomic_write_user_file(path: &Path, data: &[u8]) -> std::io::Result<()> {
    atomic_write(path, data)
}

/// atomic_write と同じ手順で、内容は `write` が一時ファイルへ書き込む (大きな出力をメモリに溜めない)。
pub fn atomic_write_with(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let target = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let fname = target.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no filename")
    })?;
    let permissions = std::fs::metadata(&target).ok().map(|m| m.permissions());

    let (tmp_path, mut file) = create_temp_file(parent, fname)?;
    let result = (|| {
        write(&mut file)?;
        if let Some(perm) = permissions {
            file.set_permissions(perm)?;
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp_path, &target)?;
        // rename をディスクに確定させる (失敗しても書き込み自体は完了している)
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

fn create_temp_file(
    parent: &Path,
    fname: &std::ffi::OsStr,
) -> std::io::Result<(std::path::PathBuf, std::fs::File)> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut last_err = None;
    for attempt in 0..16u32 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let mut name = std::ffi::OsString::from(".");
        name.push(fname);
        name.push(format!(
            ".{}.{:08x}{}.tmp",
            std::process::id(),
            nanos,
            attempt
        ));
        let tmp_path = parent.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(file) => return Ok((tmp_path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last_err = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("could not create temp file")))
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

/// パスの拡張子が allowed のいずれか (大文字小文字は区別しない) であることを確認する。
/// webview が乗っ取られても、各コマンドが本来扱う種類のファイルしか読み書きできないようにする。
pub fn require_extension(path: &Path, allowed: &[&str]) -> Result<(), String> {
    let ok = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| allowed.iter().any(|a| a.eq_ignore_ascii_case(ext)));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "対応していないファイルです: {} (拡張子 {:?})",
            path.display(),
            allowed
        ))
    }
}

/// 細工されたファイルで依存クレート (lopdf, calamine, pulldown-cmark など) が
/// panic しても、コマンドのエラーとして返す。非同期コマンドが panic すると応答が
/// 返らず、フロントは読み込み中のまま止まってしまう。
pub fn catch_panic<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err("ファイルの解析中に内部エラーが発生しました".to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn catch_panic_turns_panics_into_errors() {
        let r: Result<(), String> = catch_panic(|| panic!("boom"));
        assert!(r.is_err());
        assert_eq!(catch_panic(|| Ok(1)), Ok(1));
    }

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
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
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
    fn atomic_write_through_symlink_updates_the_target_and_keeps_the_link() {
        let dir = std::env::temp_dir().join(format!("qv_link_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.md");
        let link = dir.join("link.md");
        fs::write(&real, b"old").unwrap();
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        atomic_write(&link, b"new").unwrap();

        let link_is_symlink = fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink();
        let real_content = fs::read(&real).unwrap();
        fs::remove_dir_all(&dir).ok();
        assert!(link_is_symlink);
        assert_eq!(real_content, b"new");
    }

    #[test]
    fn atomic_write_keeps_permissions_and_leaves_no_temp_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("qv_perm_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secret.md");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        atomic_write(&path, b"new").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let entries = fs::read_dir(&dir).unwrap().count();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(mode, 0o600);
        assert_eq!(entries, 1);
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
