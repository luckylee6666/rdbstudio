use crate::db::objects::{self, ForeignKeyDefinition, IndexChange, ObjectCatalog};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn list_managed_objects(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    table: Option<String>,
) -> AppResult<ObjectCatalog> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    objects::list_managed_objects_scoped(&pool, schema.as_deref(), table.as_deref()).await
}

#[tauri::command]
pub async fn apply_index_change(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    table: String,
    change: IndexChange,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    objects::apply_index_change(&pool, schema.as_deref(), &table, &change).await
}

#[tauri::command]
pub async fn apply_foreign_key_changes(
    state: State<'_, AppState>,
    id: String,
    schema: Option<String>,
    table: String,
    foreign_keys: Vec<ForeignKeyDefinition>,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    objects::apply_foreign_key_changes(&pool, schema.as_deref(), &table, &foreign_keys).await
}

/// Apply one complete CREATE/ALTER/DROP object statement entered in the
/// manager. Read-only connections reject all definitions server-side.
#[tauri::command]
pub async fn apply_managed_object_definition(
    state: State<'_, AppState>,
    id: String,
    definition: String,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    objects::apply_object_definition(&pool, &definition, None).await
}

#[tauri::command]
pub async fn drop_managed_object(
    state: State<'_, AppState>,
    id: String,
    definition: String,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    objects::apply_object_definition(&pool, "unused", Some(&definition)).await
}

#[tauri::command]
pub async fn apply_managed_user(
    state: State<'_, AppState>,
    id: String,
    name: String,
    host: Option<String>,
    password: Option<String>,
    drop: bool,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    objects::apply_user(&pool, &name, host.as_deref(), password.as_deref(), drop).await
}

// Keep named IPC fields compatible with the object-manager form.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn apply_managed_grants(
    state: State<'_, AppState>,
    id: String,
    grantee: String,
    host: Option<String>,
    database: String,
    object: Option<String>,
    privileges: Vec<String>,
    grant: bool,
    scope: Option<String>,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    objects::apply_scoped_grants(
        &pool,
        &grantee,
        host.as_deref(),
        &database,
        object.as_deref(),
        &privileges,
        grant,
        scope.as_deref(),
    )
    .await
}

#[allow(dead_code)]
fn _foreign_key_type_anchor(_: ForeignKeyDefinition) {}

#[tauri::command]
pub async fn replace_managed_object_definition(
    state: State<'_, AppState>,
    id: String,
    original: String,
    drop_sql: String,
    definition: String,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    crate::db::objects::replace_object_definition(&pool, &original, &drop_sql, &definition).await
}
