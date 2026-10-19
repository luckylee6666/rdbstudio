use crate::db::maintenance::{self, MaintenanceAction, MaintenanceReport};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

/// Run a fixed database maintenance operation. No SQL text is accepted from
/// the caller; the backend quotes the table identifiers for the active driver.
#[tauri::command]
pub async fn maintain_table(
    state: State<'_, AppState>,
    id: String,
    action: MaintenanceAction,
    schema: Option<String>,
    table: Option<String>,
) -> AppResult<MaintenanceReport> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    let started = std::time::Instant::now();
    let message = maintenance::run(&pool, action, schema.as_deref(), table.as_deref()).await?;
    Ok(MaintenanceReport {
        action,
        message,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
