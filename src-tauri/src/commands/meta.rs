use crate::db;
use crate::error::{AppError, AppResult};
use crate::model::{ColumnInfo, TreeEntry};
use crate::state::AppState;
use tauri::State;

fn require_pool(state: &AppState, id: &str) -> AppResult<crate::db::pool::DbPool> {
    state
        .get_pool(id)
        .ok_or_else(|| AppError::msg("not connected"))
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    let pool = require_pool(&state, &id)?;
    db::meta::list_databases(&pool).await
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    id: String,
    database: Option<String>,
) -> AppResult<Vec<String>> {
    let pool = require_pool(&state, &id)?;
    db::meta::list_schemas(&pool, database.as_deref()).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
) -> AppResult<Vec<TreeEntry>> {
    let pool = require_pool(&state, &id)?;
    db::meta::list_tables(&pool, schema.as_deref()).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    let pool = require_pool(&state, &id)?;
    db::meta::list_columns(&pool, schema.as_deref(), &table).await
}

#[tauri::command]
pub async fn scan_redis_keys(
    state: State<'_, AppState>,
    id: String,
    cursor: u64,
    limit: Option<usize>,
) -> AppResult<db::redis_ops::ScanPage> {
    let pool = require_pool(&state, &id)?;
    let handle = match &pool {
        crate::db::pool::DbPool::Redis(h) => h.clone(),
        _ => return Err(AppError::msg("scan_redis_keys: not a Redis connection")),
    };
    db::redis_ops::scan_keys(&handle, cursor, limit.unwrap_or(db::redis_ops::DEFAULT_SCAN_LIMIT))
        .await
}
