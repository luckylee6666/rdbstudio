use crate::db::design::{self, TableDescription};
use crate::db::meta;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn describe_schema(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    limit: Option<usize>,
) -> AppResult<Vec<TableDescription>> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    let entries = meta::list_tables(&pool, schema.as_deref()).await?;
    let take = limit.unwrap_or(80).max(1);
    let tables: Vec<String> = entries
        .into_iter()
        .filter(|e| e.kind == "table")
        .take(take)
        .map(|e| e.name)
        .collect();

    let mut out: Vec<TableDescription> = Vec::with_capacity(tables.len());
    for t in tables {
        match design::describe(&pool, schema.as_deref(), &t).await {
            Ok(d) => out.push(d),
            Err(_) => continue,
        }
    }
    Ok(out)
}
