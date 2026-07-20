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
            let snippets = store::SnippetStore::load(&data_dir)?;
            app.manage(AppState::new(store, history, snippets));

            // macOS default menu binds ⌘W to a native "Close Window" item,
            // which fires before the webview ever sees the key — the in-app
            // close-tab shortcut was dead. Strip that single item so ⌘W
            // reaches the frontend handler; the window still closes via the
            // traffic lights or ⌘Q.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItemKind};
                let menu = Menu::default(app.handle())?;
                for item in menu.items()? {
                    if let MenuItemKind::Submenu(sm) = item {
                        for (idx, sub) in sm.items()?.iter().enumerate() {
                            let is_close_window = matches!(
                                sub,
                                MenuItemKind::Predefined(p)
                                    if p.text().map(|t| t == "Close Window").unwrap_or(false)
                            );
                            if is_close_window {
                                sm.remove_at(idx)?;
                                break; // indices shift after removal
                            }
                        }
                    }
                }
                app.set_menu(menu)?;
            }
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
            commands::snippets::list_snippets,
            commands::snippets::save_snippet,
            commands::snippets::delete_snippet,
            commands::meta::list_databases,
            commands::meta::list_schemas,
            commands::meta::list_tables,
            commands::meta::list_columns,
            commands::meta::scan_redis_keys,
            commands::query::execute_query,
            commands::query::execute_script,
            commands::query::redis_rename_member,
            commands::query::cancel_query,
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
            commands::design::drop_object,
            commands::design::table_op,
            commands::dump::dump_database,
            commands::dump::restore_database,
            commands::io::export_table,
            commands::io::import_csv,
            commands::io::preview_csv,
            commands::io::write_text_file,
            commands::schema::describe_schema,
        ])
        .run(tauri::generate_context!())
        .expect("error while running rdbstudio");
}
