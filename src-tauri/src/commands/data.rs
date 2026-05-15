use crate::db::data::{self, EditBatch, EditResult, TableQuery};
use crate::db::exec::QueryResult;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn fetch_table_data(
    state: State<'_, AppState>,
    id: String,
    query: TableQuery,
) -> AppResult<QueryResult> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    data::fetch(&pool, &query).await
}

#[tauri::command]
pub async fn count_table_rows(
    state: State<'_, AppState>,
    id: String,
    query: TableQuery,
) -> AppResult<u64> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    data::count(&pool, &query).await
}

#[tauri::command]
pub async fn apply_edits(
    state: State<'_, AppState>,
    id: String,
    batch: EditBatch,
) -> AppResult<EditResult> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    data::apply_edits(&pool, &batch).await
}

#[tauri::command]
pub async fn preview_edits(
    state: State<'_, AppState>,
    id: String,
    batch: EditBatch,
) -> AppResult<Vec<String>> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    let driver = pool.driver();
    Ok(batch
        .edits
        .iter()
        .map(|e| data::preview_edit_sql(driver, batch.schema.as_deref(), &batch.table, e))
        .collect())
}
