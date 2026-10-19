//! Dev-only: expose the backend to a browser tab. See `docs/web-bridge.md`.
//!
//! RDB_BRIDGE_TOKEN    required, at least 16 characters
//! RDB_BRIDGE_PORT     default 1430
//! RDB_BRIDGE_DATA_DIR default ~/.rdbstudio (the desktop app's store)
//! RDB_BRIDGE_ORIGINS  comma-separated, default the Vite dev server

fn main() {
    let token = std::env::var("RDB_BRIDGE_TOKEN").unwrap_or_default();
    let port = std::env::var("RDB_BRIDGE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(1430);
    let data_dir = std::env::var_os("RDB_BRIDGE_DATA_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".rdbstudio")))
        .expect("no data dir: set RDB_BRIDGE_DATA_DIR");
    let allowed_origins = std::env::var("RDB_BRIDGE_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:1420,http://127.0.0.1:1420".into())
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();

    if let Err(error) = rdbstudio_lib::web_bridge::serve(rdbstudio_lib::web_bridge::BridgeConfig {
        port,
        token,
        data_dir,
        allowed_origins,
    }) {
        eprintln!("web bridge failed: {error}");
        std::process::exit(1);
    }
}
