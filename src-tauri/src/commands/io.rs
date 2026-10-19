use crate::db::io::{
    self, CsvPreview, ExportOptions, ExportReport, ImportCsvOptions, ImportReport,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

const MAX_SQL_FILE_BYTES: u64 = 8 * 1024 * 1024;

fn read_sql_file_contents(path: &str) -> AppResult<String> {
    use std::io::Read;

    let path_ref = std::path::Path::new(path);
    let metadata = std::fs::symlink_metadata(path_ref)
        .map_err(|e| AppError::msg(format!("cannot inspect SQL file: {e}")))?;
    if !metadata.file_type().is_file() {
        return Err(AppError::msg("SQL file must be a regular file (symbolic links are not accepted)"));
    }
    if metadata.len() > MAX_SQL_FILE_BYTES {
        return Err(AppError::msg("SQL files larger than 8 MiB cannot be opened in the editor; use whole-database restore for large SQL dumps"));
    }

    let file = std::fs::File::open(path_ref)
        .map_err(|e| AppError::msg(format!("cannot open SQL file: {e}")))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_SQL_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::msg(format!("cannot read SQL file: {e}")))?;
    if bytes.len() as u64 > MAX_SQL_FILE_BYTES {
        return Err(AppError::msg("SQL files larger than 8 MiB cannot be opened in the editor; use whole-database restore for large SQL dumps"));
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.drain(..3);
    }
    let contents = String::from_utf8(bytes)
        .map_err(|_| AppError::msg("SQL file must be valid UTF-8"))?;
    if contents.contains('\0') {
        return Err(AppError::msg("SQL file must not contain NUL characters"));
    }
    Ok(contents)
}

#[tauri::command]
pub fn read_sql_file(path: String) -> AppResult<String> {
    read_sql_file_contents(&path)
}

#[tauri::command]
pub async fn export_table(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    table: String,
    options: ExportOptions,
) -> AppResult<ExportReport> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    io::export_table(&pool, schema.as_deref(), &table, &options).await
}

#[tauri::command]
pub async fn import_csv(
    state: State<'_, AppState>,
    id: String,
    options: ImportCsvOptions,
) -> AppResult<ImportReport> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    io::import_csv(&pool, &options).await
}

#[tauri::command]
pub fn preview_csv(
    path: String,
    delimiter: Option<String>,
    has_header: bool,
    limit: Option<usize>,
) -> AppResult<CsvPreview> {
    let delim = delimiter
        .as_deref()
        .and_then(|s| s.chars().next())
        .unwrap_or(',');
    io::preview_csv(&path, delim, has_header, limit.unwrap_or(5))
}

/// Write arbitrary text to a path the user picked via the dialog plugin.
/// Used for "Export to CSV" flows where the data was assembled on the JS side
/// — the browser's <a download> trick doesn't work in WKWebView, so the file
/// I/O has to go through Rust.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> AppResult<()> {
    std::fs::write(&path, contents.as_bytes())
        .map_err(|e| AppError::msg(format!("write {}: {}", path, e)))
}

#[tauri::command]
pub fn preview_import_file(path: String, sheet: Option<String>, has_header: bool) -> AppResult<crate::db::imports::FilePreview> {
    crate::db::imports::preview_file(&path, sheet.as_deref(), has_header)
}
#[tauri::command]
pub async fn import_file(state: State<'_, AppState>, id: String, options: crate::db::imports::ImportFileOptions) -> AppResult<ImportReport> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state.get_pool(&id).ok_or_else(|| AppError::msg("not connected"))?;
    crate::db::imports::import_file(&pool, &options).await
}

#[tauri::command]
pub fn read_binary_file(path: String) -> AppResult<String> {
    use base64::Engine;
    if std::fs::metadata(&path)?.len() > 8 * 1024 * 1024 { return Err(AppError::msg("binary files must be at most 8 MiB")); }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 8 * 1024 * 1024 { return Err(AppError::msg("binary files must be at most 8 MiB")); }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
#[tauri::command]
pub fn write_binary_file(path: String, base64_data: String) -> AppResult<()> {
    use base64::Engine;
    if base64_data.len() > 12 * 1024 * 1024 { return Err(AppError::msg("binary files must be at most 8 MiB")); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&base64_data).map_err(|e| AppError::msg(e.to_string()))?;
    if bytes.len() > 8 * 1024 * 1024 { return Err(AppError::msg("binary files must be at most 8 MiB")); }
    std::fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod sql_file_tests {
    use super::*;

    #[test]
    fn reads_utf8_and_strips_a_utf8_bom() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("script.sql");
        std::fs::write(&path, b"\xEF\xBB\xBFSELECT 'hello';").unwrap();
        assert_eq!(read_sql_file_contents(path.to_str().unwrap()).unwrap(), "SELECT 'hello';");
    }

    #[test]
    fn rejects_invalid_utf8_and_nul_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("script.sql");
        std::fs::write(&path, [0x53, 0x45, 0x4C, 0xFF]).unwrap();
        assert!(read_sql_file_contents(path.to_str().unwrap()).unwrap_err().to_string().contains("UTF-8"));

        std::fs::write(&path, b"SELECT 1;\0SELECT 2;").unwrap();
        assert!(read_sql_file_contents(path.to_str().unwrap()).unwrap_err().to_string().contains("NUL"));
    }

    #[test]
    fn rejects_oversized_and_non_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.sql");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_SQL_FILE_BYTES + 1).unwrap();
        assert!(read_sql_file_contents(path.to_str().unwrap()).unwrap_err().to_string().contains("whole-database restore"));
        assert!(read_sql_file_contents(dir.path().to_str().unwrap()).unwrap_err().to_string().contains("regular file"));
    }
}
