use crate::{
    analysis_presets::{Preset, PresetStore, SaveRequest, Summary},
    error::{AppError, AppResult},
    state::AppState,
};
use tauri::State;

// File validation/serialization can touch tens of MiB. Keep it off the UI and
// asynchronous database workers; the store serializes its own mutations.
async fn with_store<T: Send + 'static>(
    state: State<'_, AppState>,
    work: impl FnOnce(&PresetStore) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let store = state.analysis_presets.clone();
    tauri::async_runtime::spawn_blocking(move || work(&store))
        .await
        .map_err(|_| AppError::msg("preset_storage"))?
}
#[tauri::command]
pub async fn list_analysis_presets(state: State<'_, AppState>) -> AppResult<Vec<Summary>> {
    with_store(state, |store| store.list()).await
}
#[tauri::command]
pub async fn get_analysis_preset(state: State<'_, AppState>, id: String) -> AppResult<Preset> {
    with_store(state, move |store| store.get(&id)).await
}
#[tauri::command]
pub async fn save_analysis_preset(
    state: State<'_, AppState>,
    request: SaveRequest,
) -> AppResult<Preset> {
    with_store(state, move |store| store.save(request)).await
}
#[tauri::command]
pub async fn rename_analysis_preset(
    state: State<'_, AppState>,
    id: String,
    revision: String,
    name: String,
) -> AppResult<Preset> {
    with_store(state, move |store| store.rename(&id, &revision, &name)).await
}
#[tauri::command]
pub async fn delete_analysis_preset(
    state: State<'_, AppState>,
    id: String,
    revision: String,
) -> AppResult<()> {
    with_store(state, move |store| store.delete(&id, &revision)).await
}
