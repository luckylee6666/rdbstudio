use crate::error::{AppError, AppResult};
use crate::model::ConnectionConfig;
use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct StoreFile {
    #[serde(default)]
    connections: Vec<ConnectionConfig>,
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
        let inner = if path.exists() {
            let raw = std::fs::read(&path)?;
            serde_json::from_slice(&raw).unwrap_or_default()
        } else {
            StoreFile::default()
        };
        Ok(Self {
            path,
            inner: Arc::new(RwLock::new(inner)),
        })
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.inner
            .read()
            .connections
            .iter()
            .map(|c| {
                let mut c = c.clone();
                c.password = None;
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
        let to_return = {
            let mut guard = self.inner.write();
            let mut persisted = cfg.clone();
            persisted.password = None;
            if let Some(existing) = guard
                .connections
                .iter_mut()
                .find(|c| c.id == persisted.id)
            {
                *existing = persisted.clone();
            } else {
                guard.connections.push(persisted.clone());
            }
            persisted
        };
        self.flush()?;
        Ok(to_return)
    }

    pub fn remove(&self, id: &str) -> AppResult<bool> {
        let removed = {
            let mut guard = self.inner.write();
            let len = guard.connections.len();
            guard.connections.retain(|c| c.id != id);
            guard.connections.len() != len
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
