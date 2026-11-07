use crate::{
    error::{AppError, AppResult},
    offline_models::{ModelStore, Record, SaveRequest, Summary},
    state::AppState,
};
use tauri::State;

// File validation/serialization can touch tens of MiB. Keep it off the UI and
// asynchronous database workers; the store serializes its own mutations.
async fn with_store<T: Send + 'static>(
    state: State<'_, AppState>,
    work: impl FnOnce(&ModelStore) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let store = state.offline_models.clone();
    tauri::async_runtime::spawn_blocking(move || work(&store))
        .await
        .map_err(|_| AppError::msg("preset_storage"))?
}
#[tauri::command]
pub async fn list_offline_models(state: State<'_, AppState>) -> AppResult<Vec<Summary>> {
    with_store(state, |store| store.list()).await
}
#[tauri::command]
pub async fn get_offline_model(state: State<'_, AppState>, id: String) -> AppResult<Record> {
    with_store(state, move |store| store.get(&id)).await
}
#[tauri::command]
pub async fn save_offline_model(
    state: State<'_, AppState>,
    request: SaveRequest,
) -> AppResult<Record> {
    with_store(state, move |store| store.save(request)).await
}
#[tauri::command]
pub async fn rename_offline_model(
    state: State<'_, AppState>,
    id: String,
    revision: String,
    name: String,
) -> AppResult<Record> {
    with_store(state, move |store| store.rename(&id, &revision, &name)).await
}
#[tauri::command]
pub async fn delete_offline_model(
    state: State<'_, AppState>,
    id: String,
    revision: String,
) -> AppResult<()> {
    with_store(state, move |store| store.delete(&id, &revision)).await
}

/// Reads metadata only. Saving the returned snapshot is a separate user action.
#[tauri::command]
pub async fn preview_reverse_model(
    state: State<'_, AppState>,
    id: String,
    tables: Vec<crate::model_reverse::SourceTable>,
) -> AppResult<crate::model_reverse::Preview> {
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let _slot = SLOTS
        .try_acquire()
        .map_err(|_| AppError::msg("model_reverse_busy"))?;
    crate::model_reverse::validate_selection(&tables)?;
    let generation = state.sessions.lease(&id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    let preview = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        crate::model_reverse::inspect(&pool, &tables),
    )
    .await
    .map_err(|_| AppError::msg("model_reverse_timeout"))??;
    if state.sessions.lease(&id)? != generation || state.get_pool(&id).is_none() {
        return Err(AppError::msg("model_reverse_changed"));
    }
    Ok(preview)
}
