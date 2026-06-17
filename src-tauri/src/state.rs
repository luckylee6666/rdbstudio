use crate::db::pool::DbPool;
use crate::db::ssh::Tunnel;
use crate::history::HistoryStore;
use crate::store::{ConnectionStore, SnippetStore};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

pub struct AppState {
    pub store: ConnectionStore,
    pub history: HistoryStore,
    pub snippets: SnippetStore,
    pub pools: Arc<RwLock<HashMap<String, DbPool>>>,
    /// Live SSH tunnels keyed by connection id. Kept alive for as long as the
    /// pool is connected; dropping the entry tears down the forward.
    pub tunnels: Arc<RwLock<HashMap<String, Arc<Tunnel>>>>,
}

impl AppState {
    pub fn new(store: ConnectionStore, history: HistoryStore, snippets: SnippetStore) -> Self {
        Self {
            store,
            history,
            snippets,
            pools: Arc::new(RwLock::new(HashMap::new())),
            tunnels: Arc::new(RwLock::new(HashMap::new())),
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

    pub fn insert_tunnel(&self, id: String, tunnel: Arc<Tunnel>) {
        self.tunnels.write().insert(id, tunnel);
    }

    /// Remove and return a tunnel so the caller drops it (closing the forward)
    /// after the pool is closed.
    pub fn remove_tunnel(&self, id: &str) -> Option<Arc<Tunnel>> {
        self.tunnels.write().remove(id)
    }
}
