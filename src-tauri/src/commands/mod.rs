pub mod connections;
pub mod data;
pub mod design;
pub mod io;
pub mod meta;
pub mod query;
pub mod schema;

#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
