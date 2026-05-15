use crate::error::AppResult;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub sql: String,
    pub elapsed_ms: u64,
    pub row_count: Option<u64>,
    pub rows_affected: Option<u64>,
    pub error: Option<String>,
    pub at: String, // RFC3339
}

#[derive(Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    entries: Vec<HistoryEntry>,
}

#[derive(Clone)]
pub struct HistoryStore {
    path: PathBuf,
    inner: Arc<RwLock<File>>,
}

impl HistoryStore {
    pub fn load(app_data: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(app_data)?;
        let path = app_data.join("history.json");
        let inner = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path)?).unwrap_or_default()
        } else {
            File::default()
        };
        Ok(Self {
            path,
            inner: Arc::new(RwLock::new(inner)),
        })
    }

    pub fn push(&self, entry: HistoryEntry) -> AppResult<()> {
        {
            let mut g = self.inner.write();
            g.entries.push(entry);
            let len = g.entries.len();
            if len > MAX_ENTRIES {
                g.entries.drain(0..len - MAX_ENTRIES);
            }
        }
        self.flush()
    }

    pub fn list(&self, limit: usize) -> Vec<HistoryEntry> {
        let g = self.inner.read();
        let n = g.entries.len();
        let start = n.saturating_sub(limit);
        g.entries[start..].iter().rev().cloned().collect()
    }

    pub fn clear(&self) -> AppResult<()> {
        self.inner.write().entries.clear();
        self.flush()
    }

    fn flush(&self) -> AppResult<()> {
        let g = self.inner.read();
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&*g)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}
