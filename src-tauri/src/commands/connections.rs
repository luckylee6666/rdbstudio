use crate::db::{build_url_with, pool::DbPool, ssh, target_addr};
use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, ConnectionSummary};
use crate::secret;
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

/// Keychain entry id for a connection's SSH password/passphrase (kept separate
/// from the DB password stored under the bare connection id).
fn ssh_secret_id(id: &str) -> String {
    format!("{id}::ssh")
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Vec<ConnectionConfig> {
    state.store.list()
}

#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
) -> AppResult<ConnectionConfig> {
    let password = config.password.clone();
    let ssh_password = config.ssh.as_ref().and_then(|s| s.password.clone());
    let saved = state.store.upsert(config)?;
    // An empty password from the dialog means "leave the keychain entry
    // alone" (edit mode shows ●●●● as a placeholder but the field is blank).
    // Deleting the password is an explicit action — handled by remove or a
    // future clear_password command, never inferred from a blank field.
    if let Some(pw) = password {
        if !pw.is_empty() {
            secret::store_password(&saved.id, &pw)?;
        }
    }
    // Same "blank = keep existing" rule for the SSH secret.
    if let Some(pw) = ssh_password {
        if !pw.is_empty() {
            secret::store_password(&ssh_secret_id(&saved.id), &pw)?;
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    let _ = secret::delete_password(&id);
    let _ = secret::delete_password(&ssh_secret_id(&id));
    if let Some(pool) = state.remove_pool(&id) {
        tauri::async_runtime::spawn(async move { pool.close().await });
    }
    // Drop any live tunnel for this connection.
    let _ = state.remove_tunnel(&id);
    state.store.remove(&id)
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<String> {
    // If an SSH tunnel is configured, stand it up for the duration of the test
    // (the secret travels inline on the test request). `_tunnel` holds the
    // forward open; dropping it at scope end tears it down.
    let _tunnel;
    let url = if let Some(ssh_cfg) = config.ssh.as_ref() {
        let (db_host, db_port) = target_addr(&config);
        let secret = ssh_cfg.password.as_deref().filter(|s| !s.is_empty());
        let tunnel = ssh::open(ssh_cfg, &db_host, db_port, secret).await?;
        let local = (tunnel.local_host.clone(), tunnel.local_port);
        _tunnel = tunnel;
        build_url_with(&config, Some((local.0.as_str(), local.1)))?
    } else {
        build_url_with(&config, None)?
    };
    let pool = DbPool::connect(config.driver, &url).await?;
    let v = crate::db::meta::server_version(&pool).await?;
    pool.close().await;
    Ok(v)
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> AppResult<ConnectionSummary> {
    // A second connect for the same id while one is in flight (double-click,
    // impatient retry during a slow SSH handshake) would stack a duplicate
    // tunnel/pool and race the state inserts — reject it instead.
    if !state.begin_connect(&id) {
        return Err(AppError::msg("a connection attempt is already in progress"));
    }
    let result = connect_inner(&state, &id).await;
    state.end_connect(&id);
    result
}

async fn connect_inner(state: &AppState, id: &str) -> AppResult<ConnectionSummary> {
    let mut cfg = state
        .store
        .get(id)
        .ok_or_else(|| AppError::msg(format!("connection {} not found", id)))?;
    cfg.password = secret::read_password(id)?;

    // If this id is already connected (frontend double-click, retry, or a
    // reconnect that didn't go through `disconnect`), tear down the existing
    // pool/tunnel first. A plain re-insert would drop the old DbPool without
    // running its async `close()`, leaking sqlx connections / server sessions,
    // and would stack a second SSH forward. Mirrors `disconnect`'s ordering.
    if let Some(old) = state.remove_pool(id) {
        old.close().await;
    }
    let _ = state.remove_tunnel(id);

    // Establish an SSH tunnel first if configured, then point the pool at the
    // local forwarded endpoint. The tunnel is stored alongside the pool so it
    // lives exactly as long as the connection.
    let mut tunnel: Option<Arc<ssh::Tunnel>> = None;
    let url = if let Some(ssh_cfg) = cfg.ssh.clone() {
        let secret = secret::read_password(&ssh_secret_id(id))?;
        let (db_host, db_port) = target_addr(&cfg);
        let t = ssh::open(&ssh_cfg, &db_host, db_port, secret.as_deref()).await?;
        let local = (t.local_host.clone(), t.local_port);
        tunnel = Some(Arc::new(t));
        build_url_with(&cfg, Some((local.0.as_str(), local.1)))?
    } else {
        build_url_with(&cfg, None)?
    };

    // On pool failure the `tunnel` binding drops here, closing the forward.
    let pool = DbPool::connect(cfg.driver, &url).await?;
    let version = crate::db::meta::server_version(&pool).await.ok();
    if let Some(t) = tunnel {
        state.insert_tunnel(id.to_string(), t);
    }
    state.insert_pool(id.to_string(), pool);
    Ok(ConnectionSummary {
        id: id.to_string(),
        connected: true,
        server_version: version,
    })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(pool) = state.remove_pool(&id) {
        pool.close().await;
    }
    // Tear down the tunnel after the pool is closed.
    let _ = state.remove_tunnel(&id);
    Ok(())
}

#[tauri::command]
pub fn connection_status(state: State<'_, AppState>, id: String) -> ConnectionSummary {
    let connected = state.pools.read().contains_key(&id);
    ConnectionSummary {
        id,
        connected,
        server_version: None,
    }
}
