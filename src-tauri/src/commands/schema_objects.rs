use crate::db::schema_objects::{self, SchemaObject, SchemaObjectsResult};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn list_schema_objects(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
) -> AppResult<SchemaObjectsResult> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    schema_objects::list(&pool, schema.as_deref()).await
}

#[tauri::command]
pub async fn get_schema_object_definition(
    state: State<'_, AppState>,
    id: String,
    object: SchemaObject,
) -> AppResult<String> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    schema_objects::definition(&pool, &object).await
}
