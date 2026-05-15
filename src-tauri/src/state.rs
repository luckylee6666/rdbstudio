use crate::db::pool::DbPool;
use crate::history::HistoryStore;
use crate::store::ConnectionStore;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

pub struct AppState {
    pub store: ConnectionStore,
    pub history: HistoryStore,
    pub pools: Arc<RwLock<HashMap<String, DbPool>>>,
}

impl AppState {
    pub fn new(store: ConnectionStore, history: HistoryStore) -> Self {
        Self {
            store,
            history,
            pools: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn get_pool(&self, id: &str) -> Option<DbPool> {
        self.pools.read().get(id).cloned()
    }

    pub fn insert_pool(&self, id: String, pool: DbPool) {
        self.pools.write().insert(id, pool);
    }

    pub fn remove_pool(&self, id: &str) -> Option<DbPool> {
        self.pools.write().remove(id)
    }
}
