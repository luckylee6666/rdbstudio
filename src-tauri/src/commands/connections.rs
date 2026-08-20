use crate::db::{build_url_with, pool::DbPool, ssh, target_addr};
use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, ConnectionSummary};
use crate::secret;
use crate::state::AppState;
use crate::store::ConnectionStore;
use std::sync::Arc;
use tauri::State;

/// Keychain entry id for a connection's SSH password/passphrase (kept separate
/// from the DB password stored under the bare connection id).
fn ssh_secret_id(id: &str) -> String {
    format!("{id}::ssh")
}

trait SecretBackend {
    fn read(&self, id: &str) -> AppResult<Option<String>>;
    fn write(&self, id: &str, password: &str) -> AppResult<()>;
    fn delete(&self, id: &str) -> AppResult<()>;
}

struct OsSecretBackend;

impl SecretBackend for OsSecretBackend {
    fn read(&self, id: &str) -> AppResult<Option<String>> {
        secret::read_password(id)
    }

    fn write(&self, id: &str, password: &str) -> AppResult<()> {
        secret::store_password(id, password)
    }

    fn delete(&self, id: &str) -> AppResult<()> {
        secret::delete_password(id)
    }
}

struct SecretChange {
    id: String,
    password: String,
    previous: Option<String>,
}

fn restore_secret(backend: &impl SecretBackend, change: &SecretChange) {
    let _ = match change.previous.as_deref() {
        Some(password) => backend.write(&change.id, password),
        None => backend.delete(&change.id),
    };
}

fn save_connection_inner(
    store: &ConnectionStore,
    mut config: ConnectionConfig,
    backend: &impl SecretBackend,
) -> AppResult<ConnectionConfig> {
    if config.id.is_empty() {
        config.id = uuid::Uuid::new_v4().to_string();
    }

    let mut changes = Vec::new();
    if let Some(password) = config.password.as_deref().filter(|s| !s.is_empty()) {
        changes.push(SecretChange {
            id: config.id.clone(),
            password: password.to_string(),
            previous: backend.read(&config.id)?,
        });
    }
    if let Some(password) = config
        .ssh
        .as_ref()
        .and_then(|ssh| ssh.password.as_deref())
        .filter(|s| !s.is_empty())
    {
        let id = ssh_secret_id(&config.id);
        changes.push(SecretChange {
            previous: backend.read(&id)?,
            id,
            password: password.to_string(),
        });
    }

    for (applied, change) in changes.iter().enumerate() {
        if let Err(error) = backend.write(&change.id, &change.password) {
            for previous in changes[..applied].iter().rev() {
                restore_secret(backend, previous);
            }
            return Err(error);
        }
    }

    match store.upsert(config) {
        Ok(saved) => Ok(saved),
        Err(error) => {
            for change in changes.iter().rev() {
                restore_secret(backend, change);
            }
            Err(error)
        }
    }
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
    // Persist secrets first and roll them back if a later keychain or config
    // write fails. A failed Save must never leave a changed config on disk.
    save_connection_inner(&state.store, config, &OsSecretBackend)
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

/// Fill blank password fields from the keychain when the config already has
/// an id (edit-dialog "test" leaves the boxes empty to mean "keep stored").
fn hydrate_secrets_for_test(config: &mut ConnectionConfig) -> AppResult<()> {
    if config.id.is_empty() {
        return Ok(());
    }
    let db_blank = config
        .password
        .as_deref()
        .map(str::is_empty)
        .unwrap_or(true);
    if db_blank {
        if let Some(pw) = secret::read_password(&config.id)? {
            config.password = Some(pw);
        }
    }
    if let Some(ssh) = config.ssh.as_mut() {
        let ssh_blank = ssh.password.as_deref().map(str::is_empty).unwrap_or(true);
        if ssh_blank {
            if let Some(pw) = secret::read_password(&ssh_secret_id(&config.id))? {
                ssh.password = Some(pw);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn test_connection(mut config: ConnectionConfig) -> AppResult<String> {
    hydrate_secrets_for_test(&mut config)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DriverKind, SshConfig};
    use parking_lot::Mutex;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeSecrets {
        values: Mutex<HashMap<String, String>>,
        fail_write: Mutex<Option<String>>,
    }

    impl SecretBackend for FakeSecrets {
        fn read(&self, id: &str) -> AppResult<Option<String>> {
            Ok(self.values.lock().get(id).cloned())
        }

        fn write(&self, id: &str, password: &str) -> AppResult<()> {
            if self.fail_write.lock().as_deref() == Some(id) {
                return Err(AppError::msg("injected keychain failure"));
            }
            self.values
                .lock()
                .insert(id.to_string(), password.to_string());
            Ok(())
        }

        fn delete(&self, id: &str) -> AppResult<()> {
            self.values.lock().remove(id);
            Ok(())
        }
    }

    fn config(id: &str, name: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: name.into(),
            driver: DriverKind::Postgres,
            host: Some("localhost".into()),
            port: Some(5432),
            database: Some("postgres".into()),
            username: Some("user".into()),
            file_path: None,
            color: None,
            pinned: false,
            group: None,
            ssl_mode: Some("disable".into()),
            read_only: false,
            ssh: None,
            password: None,
        }
    }

    #[test]
    fn failed_ssh_secret_write_rolls_back_db_secret_and_config() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionStore::load(dir.path()).unwrap();
        store.upsert(config("conn-1", "before")).unwrap();

        let backend = FakeSecrets::default();
        backend
            .values
            .lock()
            .insert("conn-1".into(), "old-db".into());
        backend
            .values
            .lock()
            .insert("conn-1::ssh".into(), "old-ssh".into());
        *backend.fail_write.lock() = Some("conn-1::ssh".into());

        let mut edited = config("conn-1", "after");
        edited.password = Some("new-db".into());
        edited.ssh = Some(SshConfig {
            host: "bastion".into(),
            port: 22,
            username: "ssh-user".into(),
            auth: Some("password".into()),
            key_path: None,
            password: Some("new-ssh".into()),
        });

        assert!(save_connection_inner(&store, edited, &backend).is_err());
        assert_eq!(store.get("conn-1").unwrap().name, "before");
        assert_eq!(backend.values.lock().get("conn-1").unwrap(), "old-db");
        assert_eq!(backend.values.lock().get("conn-1::ssh").unwrap(), "old-ssh");
    }

    #[test]
    fn new_connection_gets_one_id_for_config_and_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionStore::load(dir.path()).unwrap();
        let backend = FakeSecrets::default();
        let mut new_config = config("", "new");
        new_config.password = Some("db-secret".into());

        let saved = save_connection_inner(&store, new_config, &backend).unwrap();
        assert!(!saved.id.is_empty());
        assert!(store.get(&saved.id).is_some());
        assert_eq!(backend.values.lock().get(&saved.id).unwrap(), "db-secret");
    }
}
