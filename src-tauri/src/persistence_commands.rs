use tauri::Manager;

#[tauri::command]
pub fn save_app_data(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.json", key));
    std::fs::write(file, value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_app_data(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.json", key));
    if !file.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(file).map(Some).map_err(|e| e.to_string())
}
