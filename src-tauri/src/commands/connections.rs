use crate::db::{build_url, pool::DbPool};
use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, ConnectionSummary};
use crate::secret;
use crate::state::AppState;
use tauri::State;

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
    let saved = state.store.upsert(config)?;
    if let Some(pw) = password {
        if pw.is_empty() {
            secret::delete_password(&saved.id)?;
        } else {
            secret::store_password(&saved.id, &pw)?;
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    let _ = secret::delete_password(&id);
    if let Some(pool) = state.remove_pool(&id) {
        tauri::async_runtime::spawn(async move { pool.close().await });
    }
    state.store.remove(&id)
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<String> {
    let url = build_url(&config)?;
    let pool = DbPool::connect(config.driver, &url).await?;
    let v = crate::db::meta::server_version(&pool).await?;
    pool.close().await;
    Ok(v)
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<ConnectionSummary> {
    let mut cfg = state
        .store
        .get(&id)
        .ok_or_else(|| AppError::msg(format!("connection {} not found", id)))?;
    cfg.password = secret::read_password(&id)?;
    let url = build_url(&cfg)?;
    let pool = DbPool::connect(cfg.driver, &url).await?;
    let version = crate::db::meta::server_version(&pool).await.ok();
    state.insert_pool(id.clone(), pool);
    Ok(ConnectionSummary {
        id,
        connected: true,
        server_version: version,
    })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(pool) = state.remove_pool(&id) {
        pool.close().await;
    }
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
