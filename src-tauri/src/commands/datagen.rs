use crate::db::datagen::{self, DataGenOptions, DataGenPreview, DataGenReport};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn preview_generated_data(
    options: DataGenOptions,
    limit: Option<usize>,
) -> AppResult<DataGenPreview> {
    datagen::preview_generated_data(&options, limit.unwrap_or(5))
}

#[tauri::command]
pub async fn generate_table_data(
    state: State<'_, AppState>,
    id: String,
    options: DataGenOptions,
) -> AppResult<DataGenReport> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    datagen::generate_table_data(&pool, &options).await
}
