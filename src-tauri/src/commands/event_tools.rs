use crate::commands::ensure_writable;
use crate::db::event_tools::{self, EventDetails, EventOptions};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

fn pool(state: &AppState, id: &str) -> AppResult<crate::db::pool::DbPool> {
    state
        .get_pool(id)
        .ok_or_else(|| AppError::msg(format!("connection {id} is not connected")))
}

#[tauri::command]
pub async fn get_event_options(
    state: State<'_, AppState>,
    id: String,
    schema: String,
    name: String,
) -> AppResult<EventDetails> {
    event_tools::get_event_options(&pool(&state, &id)?, &schema, &name).await
}

#[tauri::command]
pub async fn save_event(
    state: State<'_, AppState>,
    id: String,
    options: EventOptions,
    create: bool,
) -> AppResult<EventDetails> {
    ensure_writable(&state, &id)?;
    let pool = pool(&state, &id)?;
    let schema = options.schema.clone();
    let name = options.name.clone();
    event_tools::save_event(&pool, options, create).await?;
    event_tools::get_event_options(&pool, &schema, &name).await
}

#[tauri::command]
pub async fn set_event_enabled(
    state: State<'_, AppState>,
    id: String,
    schema: String,
    name: String,
    enabled: bool,
) -> AppResult<()> {
    ensure_writable(&state, &id)?;
    event_tools::set_event_enabled(&pool(&state, &id)?, &schema, &name, enabled).await
}

#[tauri::command]
pub async fn drop_event(
    state: State<'_, AppState>,
    id: String,
    schema: String,
    name: String,
) -> AppResult<()> {
    ensure_writable(&state, &id)?;
    event_tools::drop_event(&pool(&state, &id)?, &schema, &name).await
}
