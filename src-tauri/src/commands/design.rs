use crate::db::alter::{self, AlterPlan, DesignerChange};
use crate::db::design::{self, TableDescription};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn describe_table(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<TableDescription> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    design::describe(&pool, schema.as_deref(), &table).await
}

#[tauri::command]
pub async fn show_ddl(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<String> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    design::ddl(&pool, schema.as_deref(), &table).await
}

#[tauri::command]
pub async fn generate_alter_ddl(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    table: String,
    change: DesignerChange,
) -> AppResult<AlterPlan> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    alter::generate_alter(&pool, schema.as_deref(), &table, &change).await
}

#[tauri::command]
pub async fn apply_alter_ddl(
    state: State<'_, AppState>,
    id: String,
    statements: Vec<String>,
) -> AppResult<Vec<String>> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    alter::apply_statements(&pool, &statements).await
}
