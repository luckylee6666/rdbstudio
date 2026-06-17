use crate::error::AppResult;
use crate::model::Snippet;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Vec<Snippet> {
    state.snippets.list()
}

#[tauri::command]
pub fn save_snippet(
    state: State<'_, AppState>,
    snippet: Snippet,
) -> AppResult<Snippet> {
    state.snippets.upsert(snippet)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    state.snippets.remove(&id)
}
