use crate::db::monitor::{self, ServerMonitorSnapshot};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn server_monitor_snapshot(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<ServerMonitorSnapshot> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    monitor::server_monitor_snapshot(&pool).await
}

#[tauri::command]
pub async fn kill_server_process(
    state: State<'_, AppState>,
    id: String,
    process_id: String,
    cancel_only: bool,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    monitor::kill_server_process(&pool, &process_id, cancel_only).await
}
