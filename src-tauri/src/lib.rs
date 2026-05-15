mod commands;
pub mod db;
pub mod error;
mod history;
pub mod model;
mod secret;
mod state;
mod store;

use history::HistoryStore;
use state::AppState;
use store::ConnectionStore;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("no app data dir");
            let store = ConnectionStore::load(&data_dir)?;
            let history = HistoryStore::load(&data_dir)?;
            app.manage(AppState::new(store, history));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::test_connection,
            commands::connections::connect,
            commands::connections::disconnect,
            commands::connections::connection_status,
            commands::meta::list_databases,
            commands::meta::list_schemas,
            commands::meta::list_tables,
            commands::meta::list_columns,
            commands::meta::scan_redis_keys,
            commands::query::execute_query,
            commands::query::list_history,
            commands::query::clear_history,
            commands::data::fetch_table_data,
            commands::data::count_table_rows,
            commands::data::apply_edits,
            commands::data::preview_edits,
            commands::design::describe_table,
            commands::design::show_ddl,
            commands::design::generate_alter_ddl,
            commands::design::apply_alter_ddl,
            commands::io::export_table,
            commands::io::import_csv,
            commands::io::preview_csv,
            commands::io::write_text_file,
            commands::schema::describe_schema,
        ])
        .run(tauri::generate_context!())
        .expect("error while running rdbstudio");
}
