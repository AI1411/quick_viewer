use std::io::Write;
use std::path::Path;

/// temp file → sync → rename パターンのアトミック書込。
/// 中断・ディスクフルによるゼロバイト化を防ぐ。
///
/// - path がシンボリックリンクなら、リンク自体ではなくリンク先を置き換える
/// - 既存ファイルのパーミッションを引き継ぐ (0600 の秘密ファイルが 0644 にならない)
/// - 一時ファイルは推測しにくい名前で排他的に作る (既存のファイルやリンクを辿らない)
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
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
        file.write_all(data)?;
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
        name.push(format!(".{}.{:08x}{}.tmp", std::process::id(), nanos, attempt));
        let tmp_path = parent.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp_path) {
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
    use std::fs;

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

        let link_is_symlink = fs::symlink_metadata(&link).unwrap().file_type().is_symlink();
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
