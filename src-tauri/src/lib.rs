mod commands;
pub mod db;
pub mod error;
mod history;
pub mod model;
mod secret;
mod state;
mod storage;
mod store;
#[cfg(feature = "web-bridge")]
pub mod web_bridge;

use history::HistoryStore;
use state::AppState;
use store::ConnectionStore;
use tauri::Manager;

/// Exposed for the on-disk SQLite round-trip test; the Tauri command wraps it
/// with the pool/connection checks.
pub use commands::dump::restore_sqlite_file;

/// The full IPC command table, shared by the desktop app and the dev-only
/// web bridge so the two can never drift apart. Generic over the runtime so
/// the bridge can drive it through Tauri's mock runtime.
fn command_handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::native_copy::preview_native_copy,
        commands::native_copy::apply_native_copy,
        commands::native_copy::native_copy_progress,
        commands::native_copy::cancel_native_copy,
        commands::objects::list_managed_objects,
        commands::objects::apply_index_change,
        commands::objects::apply_foreign_key_changes,
        commands::objects::apply_managed_object_definition,
        commands::objects::replace_managed_object_definition,
        commands::objects::drop_managed_object,
        commands::objects::apply_managed_user,
        commands::objects::apply_managed_grants,
        commands::sync::preview_sync,
        commands::sync::apply_structure_sync,
        commands::sync::apply_data_sync,
        commands::sync::search_global_data,
        commands::redis_tools::redis_hscan,
        commands::redis_tools::redis_sscan,
        commands::redis_tools::redis_xrange,
        commands::redis_tools::redis_xadd,
        commands::redis_tools::redis_xdel,
        commands::redis_tools::redis_xinfo_groups,
        commands::redis_tools::redis_xgroup_create,
        commands::redis_tools::redis_xgroup_destroy,
        commands::redis_tools::redis_cluster_snapshot,
        commands::redis_tools::redis_list_set_cas,
        commands::redis_tools::redis_list_delete_cas,
        commands::redis_tools::redis_pubsub_start,
        commands::redis_tools::redis_pubsub_poll,
        commands::redis_tools::redis_pubsub_stop,
        commands::restart_application,
        commands::app_version,
        commands::connections::list_connections,
        commands::connections::save_connection,
        commands::connections::delete_connection,
        commands::connections::test_connection,
        commands::connections::connect,
        commands::connections::disconnect,
        commands::connections::connection_status,
        commands::navicat::preview_navicat_connections,
        commands::snippets::list_snippets,
        commands::snippets::save_snippet,
        commands::snippets::delete_snippet,
        commands::meta::list_databases,
        commands::meta::list_schemas,
        commands::meta::list_tables,
        commands::meta::list_columns,
        commands::maintenance::maintain_table,
        commands::meta::scan_redis_keys,
        commands::schema_objects::list_schema_objects,
        commands::schema_objects::get_schema_object_definition,
        commands::event_tools::get_event_options,
        commands::event_tools::save_event,
        commands::event_tools::set_event_enabled,
        commands::event_tools::drop_event,
        commands::sequence_tools::get_sequence_options,
        commands::sequence_tools::save_sequence,
        commands::sequence_tools::drop_sequence,
        commands::mcp::mcp_status,
        commands::mcp::start_mcp,
        commands::mcp::stop_mcp,
        commands::mcp::create_mcp_authorization,
        commands::mcp::revoke_mcp_authorizations,
        commands::query::execute_query,
        commands::query::execute_script,
        commands::query::close_editor_session,
        commands::query::editor_session_status,
        commands::query::redis_rename_member,
        commands::query::redis_create_key,
        commands::query::redis_rename_key,
        commands::query::redis_set_ttl,
        commands::query::redis_delete_member,
        commands::query::redis_delete_key,
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
        commands::dump::cancel_db_io,
        commands::dump::db_io_progress,
        commands::io::export_table,
        commands::io::import_csv,
        commands::io::preview_csv,
        commands::io::preview_import_file,
        commands::io::read_sql_file,
        commands::io::import_file,
        commands::io::write_text_file,
        commands::io::read_binary_file,
        commands::io::write_binary_file,
        commands::schema::describe_schema,
    ]
}

/// Load the persistent stores from `data_dir` into the shared app state.
fn load_state(data_dir: &std::path::Path) -> Result<AppState, Box<dyn std::error::Error>> {
    let store = ConnectionStore::load(data_dir)?;
    let history = HistoryStore::load(data_dir)?;
    let snippets = store::SnippetStore::load(data_dir)?;
    Ok(AppState::new(store, history, snippets))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let legacy_data_dir = app.path().app_data_dir().expect("no app data dir");
            let home_dir = app.path().home_dir().expect("no home dir");
            let data_dir = storage::prepare_data_dir(&home_dir, &legacy_data_dir)?;
            app.manage(load_state(&data_dir)?);

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
        .invoke_handler(command_handler())
        .run(tauri::generate_context!())
        .expect("error while running rdbstudio");
}
