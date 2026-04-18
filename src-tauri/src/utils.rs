use std::io::Write;
use std::path::Path;

/// temp file → sync → rename パターンのアトミック書込。
/// 中断・ディスクフルによるゼロバイト化を防ぐ。
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let fname = path.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no filename")
    })?;
    let mut tmp_name = fname.to_os_string();
    tmp_name.push(format!(".{}.tmp", std::process::id()));
    let tmp_path = parent.join(tmp_name);

    let mut file = std::fs::File::create(&tmp_path)?;
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp_path, path)
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
