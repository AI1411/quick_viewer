use tauri::Manager;

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("key must not be empty".to_string());
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("invalid key: {key}. Only [a-zA-Z0-9_] allowed"));
    }
    Ok(())
}

#[tauri::command]
pub fn save_app_data(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.json", key));
    crate::utils::atomic_write(&file, value.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_app_data(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.json", key));
    if !file.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(file)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_key;

    #[test]
    fn valid_keys_accepted() {
        assert!(validate_key("settings").is_ok());
        assert!(validate_key("recent_files").is_ok());
        assert!(validate_key("abc123").is_ok());
        assert!(validate_key("ABC_XYZ").is_ok());
    }

    #[test]
    fn path_traversal_rejected() {
        assert!(validate_key("../etc/passwd").is_err());
        assert!(validate_key("../../secret").is_err());
        assert!(validate_key("foo/bar").is_err());
        assert!(validate_key("foo.bar").is_err());
        assert!(validate_key("").is_err());
        assert!(validate_key("key with space").is_err());
    }
}
