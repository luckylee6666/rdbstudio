use crate::error::{AppError, AppResult};
use crate::model::ConnectionConfig;
use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct StoreFile {
    #[serde(default)]
    connections: Vec<ConnectionConfig>,
}

/// Read + parse a JSON store file. A corrupt file is moved aside to
/// `<file>.json.corrupt` — so the next flush can't overwrite the user's only
/// copy — and the caller starts from `T::default()` instead of silently
/// wiping the data or failing app boot.
pub(crate) fn load_json_or_quarantine<T: serde::de::DeserializeOwned + Default>(
    path: &Path,
) -> AppResult<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = std::fs::read(path)?;
    match serde_json::from_slice(&raw) {
        Ok(v) => Ok(v),
        Err(e) => {
            let quarantine = path.with_extension("json.corrupt");
            let _ = std::fs::rename(path, &quarantine);
            eprintln!(
                "rdbstudio: {} is corrupt ({e}); moved to {} and starting fresh",
                path.display(),
                quarantine.display()
            );
            Ok(T::default())
        }
    }
}

fn strip_connection_secrets(cfg: &mut ConnectionConfig) -> bool {
    let mut stripped = cfg.password.take().is_some();
    if let Some(ssh) = cfg.ssh.as_mut() {
        stripped |= ssh.password.take().is_some();
    }
    stripped
}

#[derive(Clone)]
pub struct ConnectionStore {
    path: PathBuf,
    inner: Arc<RwLock<StoreFile>>,
}

impl ConnectionStore {
    pub fn load(app_data: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(app_data)?;
        let path = app_data.join("connections.json");
        let mut inner: StoreFile = load_json_or_quarantine(&path)?;
        let mut had_plaintext_secrets = false;
        for conn in &mut inner.connections {
            had_plaintext_secrets |= strip_connection_secrets(conn);
        }
        let store = Self {
            path,
            inner: Arc::new(RwLock::new(inner)),
        };
        if had_plaintext_secrets {
            store.flush()?;
        }
        Ok(store)
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.inner
            .read()
            .connections
            .iter()
            .map(|c| {
                let mut c = c.clone();
                let _ = strip_connection_secrets(&mut c);
                c
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<ConnectionConfig> {
        self.inner
            .read()
            .connections
            .iter()
            .find(|c| c.id == id)
            .cloned()
    }

    pub fn upsert(&self, mut cfg: ConnectionConfig) -> AppResult<ConnectionConfig> {
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        let mut guard = self.inner.write();
        let mut next = guard.clone();
        let to_return = {
            let mut persisted = cfg.clone();
            let _ = strip_connection_secrets(&mut persisted);
            if let Some(existing) = next.connections.iter_mut().find(|c| c.id == persisted.id) {
                *existing = persisted.clone();
            } else {
                next.connections.push(persisted.clone());
            }
            persisted
        };
        self.persist(&next)?;
        *guard = next;
        Ok(to_return)
    }

    pub fn remove(&self, id: &str) -> AppResult<bool> {
        let mut guard = self.inner.write();
        let mut next = guard.clone();
        let len = next.connections.len();
        next.connections.retain(|c| c.id != id);
        let removed = next.connections.len() != len;
        if removed {
            self.persist(&next)?;
            *guard = next;
        }
        Ok(removed)
    }

    fn flush(&self) -> AppResult<()> {
        let guard = self.inner.read();
        self.persist(&guard)
    }

    fn persist(&self, data: &StoreFile) -> AppResult<()> {
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(data)?;
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path).map_err(AppError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DriverKind, SshConfig};

    fn connection_with_secrets() -> ConnectionConfig {
        ConnectionConfig {
            id: "conn-1".into(),
            name: "Test".into(),
            driver: DriverKind::Postgres,
            host: Some("localhost".into()),
            port: Some(5432),
            database: Some("postgres".into()),
            username: Some("user".into()),
            file_path: None,
            color: None,
            pinned: false,
            group: None,
            ssl_mode: None,
            read_only: false,
            ssh: Some(SshConfig {
                host: "bastion".into(),
                port: 22,
                username: "ssh-user".into(),
                auth: Some("password".into()),
                key_path: None,
                password: Some("ssh-secret".into()),
            }),
            password: Some("db-secret".into()),
        }
    }

    #[test]
    fn connection_store_never_persists_or_lists_nested_ssh_password() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = ConnectionStore::load(dir.path()).expect("load store");
        let saved = store
            .upsert(connection_with_secrets())
            .expect("save connection");

        assert!(saved.password.is_none());
        assert!(saved
            .ssh
            .as_ref()
            .and_then(|s| s.password.as_ref())
            .is_none());

        let raw = std::fs::read_to_string(dir.path().join("connections.json")).expect("read store");
        assert!(!raw.contains("db-secret"), "{raw}");
        assert!(!raw.contains("ssh-secret"), "{raw}");

        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].password.is_none());
        assert!(listed[0]
            .ssh
            .as_ref()
            .and_then(|s| s.password.as_ref())
            .is_none());
    }

    #[test]
    fn corrupt_store_is_quarantined_not_wiped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("connections.json");
        std::fs::write(&path, b"{ definitely not json").expect("write corrupt");

        let store = ConnectionStore::load(dir.path()).expect("load survives corruption");
        assert!(store.list().is_empty());

        // The damaged bytes must survive in the quarantine file so the user
        // can recover manually; a subsequent flush must not clobber them.
        let quarantined =
            std::fs::read(dir.path().join("connections.json.corrupt")).expect("quarantine exists");
        assert_eq!(quarantined, b"{ definitely not json");

        store
            .upsert(connection_with_secrets())
            .expect("store usable after quarantine");
        let quarantined_after =
            std::fs::read(dir.path().join("connections.json.corrupt")).expect("still there");
        assert_eq!(quarantined_after, b"{ definitely not json");
    }

    #[test]
    fn connection_store_load_scrubs_plaintext_secrets_from_existing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("connections.json"),
            r#"{
              "connections": [
                {
                  "id": "conn-1",
                  "name": "DB secret",
                  "driver": "postgres",
                  "username": "user",
                  "password": "old-db-secret"
                },
                {
                  "id": "conn-2",
                  "name": "SSH secret",
                  "driver": "postgres",
                  "username": "user",
                  "ssh": {
                    "host": "bastion",
                    "username": "ssh-user",
                    "password": "old-ssh-secret"
                  }
                }
              ]
            }"#,
        )
        .expect("write old store");

        let store = ConnectionStore::load(dir.path()).expect("load old store");
        let listed = store.list();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|c| c.password.is_none()));
        assert!(listed
            .iter()
            .all(|c| c.ssh.as_ref().and_then(|s| s.password.as_ref()).is_none()));

        let raw = std::fs::read_to_string(dir.path().join("connections.json")).expect("read store");
        assert!(!raw.contains("old-db-secret"), "{raw}");
        assert!(!raw.contains("old-ssh-secret"), "{raw}");
    }

    #[test]
    fn failed_flush_does_not_change_in_memory_connection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = ConnectionStore::load(dir.path()).expect("load store");
        let mut original = connection_with_secrets();
        original.password = None;
        original.ssh = None;
        store.upsert(original.clone()).expect("initial save");

        std::fs::create_dir(dir.path().join("connections.json.tmp"))
            .expect("block temporary file creation");
        let mut edited = original;
        edited.name = "must not stick".into();

        assert!(store.upsert(edited).is_err());
        assert_eq!(store.get("conn-1").unwrap().name, "Test");
    }
}

use crate::model::Snippet;

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct SnippetsFile {
    #[serde(default)]
    snippets: Vec<Snippet>,
}

#[derive(Clone)]
pub struct SnippetStore {
    path: PathBuf,
    inner: Arc<RwLock<SnippetsFile>>,
}

impl SnippetStore {
    pub fn load(app_data: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(app_data)?;
        let path = app_data.join("snippets.json");
        let inner: SnippetsFile = load_json_or_quarantine(&path)?;
        Ok(Self {
            path,
            inner: Arc::new(RwLock::new(inner)),
        })
    }

    pub fn list(&self) -> Vec<Snippet> {
        self.inner.read().snippets.clone()
    }

    pub fn upsert(&self, mut snippet: Snippet) -> AppResult<Snippet> {
        if snippet.id.is_empty() {
            snippet.id = uuid::Uuid::new_v4().to_string();
        }
        let to_return = {
            let mut guard = self.inner.write();
            if let Some(existing) = guard.snippets.iter_mut().find(|s| s.id == snippet.id) {
                *existing = snippet.clone();
            } else {
                guard.snippets.push(snippet.clone());
            }
            snippet
        };
        self.flush()?;
        Ok(to_return)
    }

    pub fn remove(&self, id: &str) -> AppResult<bool> {
        let removed = {
            let mut guard = self.inner.write();
            let len = guard.snippets.len();
            guard.snippets.retain(|s| s.id != id);
            guard.snippets.len() != len
        };
        if removed {
            self.flush()?;
        }
        Ok(removed)
    }

    fn flush(&self) -> AppResult<()> {
        let guard = self.inner.read();
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(&*guard)?;
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path).map_err(AppError::from)
    }
}
