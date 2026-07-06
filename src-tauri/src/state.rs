use crate::db::pool::DbPool;
use crate::db::ssh::Tunnel;
use crate::history::HistoryStore;
use crate::store::{ConnectionStore, SnippetStore};
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::task::AbortHandle;

pub struct AppState {
    pub store: ConnectionStore,
    pub history: HistoryStore,
    pub snippets: SnippetStore,
    pub pools: Arc<RwLock<HashMap<String, DbPool>>>,
    /// Live SSH tunnels keyed by connection id. Kept alive for as long as the
    /// pool is connected; dropping the entry tears down the forward.
    pub tunnels: Arc<RwLock<HashMap<String, Arc<Tunnel>>>>,
    /// In-flight `execute_query` tasks keyed by the frontend-issued query id,
    /// so `cancel_query` can abort them mid-flight.
    pub queries: Arc<RwLock<HashMap<String, AbortHandle>>>,
    /// Connection ids with a `connect` currently in flight — guards against a
    /// second click stacking a duplicate tunnel/pool while the first (possibly
    /// slow, SSH) attempt is still running.
    pub connecting: Arc<RwLock<HashSet<String>>>,
}

impl AppState {
    pub fn new(store: ConnectionStore, history: HistoryStore, snippets: SnippetStore) -> Self {
        Self {
            store,
            history,
            snippets,
            pools: Arc::new(RwLock::new(HashMap::new())),
            tunnels: Arc::new(RwLock::new(HashMap::new())),
            queries: Arc::new(RwLock::new(HashMap::new())),
            connecting: Arc::new(RwLock::new(HashSet::new())),
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

    pub fn register_query(&self, qid: &str, handle: AbortHandle) {
        self.queries.write().insert(qid.to_string(), handle);
    }

    pub fn unregister_query(&self, qid: &str) {
        self.queries.write().remove(qid);
    }

    /// Abort a running query by its frontend-issued id. Returns whether a
    /// matching in-flight query existed.
    pub fn cancel_query(&self, qid: &str) -> bool {
        match self.queries.write().remove(qid) {
            Some(h) => {
                h.abort();
                true
            }
            None => false,
        }
    }

    /// Mark a connection id as having a `connect` in flight. Returns false if
    /// one is already in progress (the caller should bail out).
    pub fn begin_connect(&self, id: &str) -> bool {
        self.connecting.write().insert(id.to_string())
    }

    pub fn end_connect(&self, id: &str) {
        self.connecting.write().remove(id);
    }
}
