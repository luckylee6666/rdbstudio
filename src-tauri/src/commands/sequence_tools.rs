use crate::db::sequence_tools::{self, SequenceOptions};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_sequence_options(
    state: State<'_, AppState>,
    id: String,
    schema: String,
    name: String,
) -> AppResult<SequenceOptions> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    sequence_tools::get_sequence_options(&pool, &schema, &name).await
}

#[tauri::command]
pub async fn save_sequence(
    state: State<'_, AppState>,
    id: String,
    options: SequenceOptions,
    create: bool,
    restart: Option<String>,
) -> AppResult<SequenceOptions> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    sequence_tools::save_sequence(&pool, &options, create, restart.as_deref()).await
}

#[tauri::command]
pub async fn drop_sequence(
    state: State<'_, AppState>,
    id: String,
    schema: String,
    name: String,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    sequence_tools::drop_sequence(&pool, &schema, &name).await
}
