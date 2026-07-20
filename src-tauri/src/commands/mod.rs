pub mod connections;
pub mod data;
pub mod design;
pub mod dump;
pub mod io;
pub mod meta;
pub mod query;
pub mod schema;
pub mod snippets;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Server-side gate for the connection-level read-only switch. Every command
/// that mutates data or schema must pass through here — the frontend hiding a
/// button is not a guarantee.
pub(crate) fn ensure_writable(state: &AppState, id: &str) -> AppResult<()> {
    if state.store.get(id).map(|c| c.read_only).unwrap_or(false) {
        return Err(AppError::msg(
            "connection is read-only — writes are blocked (disable read-only mode in the connection settings)",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
