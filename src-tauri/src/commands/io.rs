use crate::db::io::{
    self, CsvPreview, ExportOptions, ExportReport, ImportCsvOptions, ImportReport,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

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
