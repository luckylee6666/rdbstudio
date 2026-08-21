use crate::db::pool::DbPool;
use crate::db::ssh::Tunnel;
use crate::history::HistoryStore;
use crate::store::{ConnectionStore, SnippetStore};
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{oneshot, Mutex as AsyncMutex, Semaphore};
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct McpGrant {
    pub connection_id: String,
    pub expires_at: Instant,
    pub expires_at_text: String,
    pub cancellation: CancellationToken,
}

#[derive(Default)]
struct McpRuntimeInner {
    url: Option<String>,
    stop: Option<oneshot::Sender<()>>,
    grants: HashMap<String, McpGrant>,
}

pub(crate) struct McpRuntime {
    inner: RwLock<McpRuntimeInner>,
    pub start_lock: AsyncMutex<()>,
    pub request_slots: Arc<Semaphore>,
    pub connection_slots: Arc<Semaphore>,
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self {
            inner: RwLock::new(McpRuntimeInner::default()),
            start_lock: AsyncMutex::new(()),
            // Avoid an accidental AI loop flooding the database with parallel
            // metadata calls or long-running SELECTs.
            request_slots: Arc::new(Semaphore::new(8)),
            // Bound incomplete headers, slow request bodies, and idle HTTP/1
            // keep-alive clients before spawning unbounded per-socket work.
            connection_slots: Arc::new(Semaphore::new(32)),
        }
    }
}

impl McpRuntime {
    fn prune_expired(inner: &mut McpRuntimeInner) {
        let now = Instant::now();
        inner.grants.retain(|_, grant| {
            let active = grant.expires_at > now && !grant.cancellation.is_cancelled();
            if !active {
                grant.cancellation.cancel();
            }
            active
        });
    }

    fn cancel_all(inner: &mut McpRuntimeInner) {
        for (_, grant) in inner.grants.drain() {
            grant.cancellation.cancel();
        }
    }

    pub fn status(&self) -> (Option<String>, usize) {
        let mut inner = self.inner.write();
        Self::prune_expired(&mut inner);
        (inner.url.clone(), inner.grants.len())
    }

    pub fn set_server(&self, url: String, stop: oneshot::Sender<()>) {
        let mut inner = self.inner.write();
        inner.url = Some(url);
        inner.stop = Some(stop);
    }

    pub fn mark_stopped(&self, expected_url: &str) {
        let mut inner = self.inner.write();
        // An old listener may finish after a new one has already started.
        // Only clear the generation that actually stopped.
        if inner.url.as_deref() != Some(expected_url) {
            return;
        }
        inner.url = None;
        inner.stop = None;
        Self::cancel_all(&mut inner);
    }

    pub fn stop(&self) {
        let stop = {
            let mut inner = self.inner.write();
            inner.url = None;
            Self::cancel_all(&mut inner);
            inner.stop.take()
        };
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
    }

    pub fn add_grant(&self, token: String, grant: McpGrant) {
        let mut inner = self.inner.write();
        // Keep one live token per connection. Generating a replacement from
        // the dialog immediately invalidates the older copied configuration.
        inner.grants.retain(|_, existing| {
            let keep = existing.connection_id != grant.connection_id;
            if !keep {
                existing.cancellation.cancel();
            }
            keep
        });
        inner.grants.insert(token, grant);
    }

    pub fn grant(&self, token: &str) -> Option<McpGrant> {
        let mut inner = self.inner.write();
        Self::prune_expired(&mut inner);
        inner.grants.get(token).cloned()
    }

    pub fn revoke_all(&self) {
        Self::cancel_all(&mut self.inner.write());
    }

    pub fn revoke_connection(&self, connection_id: &str) {
        self.inner.write().grants.retain(|_, grant| {
            let keep = grant.connection_id != connection_id;
            if !keep {
                grant.cancellation.cancel();
            }
            keep
        });
    }
}

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
    /// Local, in-memory MCP server and short-lived per-connection grants.
    /// Tokens and authorization state are never persisted to disk.
    pub(crate) mcp: McpRuntime,
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
            mcp: McpRuntime::default(),
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

    /// Register a cancellable query. Duplicate renderer-issued ids are
    /// rejected so one task cannot overwrite another task's abort handle.
    pub fn register_query(&self, qid: &str, handle: AbortHandle) -> bool {
        let mut queries = self.queries.write();
        if queries.contains_key(qid) {
            return false;
        }
        queries.insert(qid.to_string(), handle);
        true
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn grant(connection_id: &str, expires_at: Instant) -> McpGrant {
        McpGrant {
            connection_id: connection_id.to_string(),
            expires_at,
            expires_at_text: "later".to_string(),
            cancellation: CancellationToken::new(),
        }
    }

    #[test]
    fn mcp_replaces_older_token_for_the_same_connection() {
        let runtime = McpRuntime::default();
        let later = Instant::now() + Duration::from_secs(60);
        runtime.add_grant("old".into(), grant("a", later));
        runtime.add_grant("other".into(), grant("b", later));
        runtime.add_grant("new".into(), grant("a", later));

        assert!(runtime.grant("old").is_none());
        assert!(runtime.grant("new").is_some());
        assert!(runtime.grant("other").is_some());
        assert_eq!(runtime.status().1, 2);
    }

    #[test]
    fn replacing_or_revoking_a_connection_cancels_in_flight_grants() {
        let runtime = McpRuntime::default();
        let later = Instant::now() + Duration::from_secs(60);
        let first = grant("connection-a", later);
        let first_cancel = first.cancellation.clone();
        runtime.add_grant("first".into(), first);

        let replacement = grant("connection-a", later);
        runtime.add_grant("replacement".into(), replacement.clone());
        assert!(first_cancel.is_cancelled());
        assert!(runtime.grant("first").is_none());
        assert!(runtime.grant("replacement").is_some());

        runtime.revoke_connection("connection-a");
        assert!(replacement.cancellation.is_cancelled());
        assert!(runtime.grant("replacement").is_none());
    }

    #[test]
    fn revoking_one_connection_keeps_other_authorizations_active() {
        let runtime = McpRuntime::default();
        let later = Instant::now() + Duration::from_secs(60);
        let first = grant("connection-a", later);
        let second = grant("connection-b", later);
        runtime.add_grant("first".into(), first.clone());
        runtime.add_grant("second".into(), second.clone());

        runtime.revoke_connection("connection-a");
        assert!(first.cancellation.is_cancelled());
        assert!(!second.cancellation.is_cancelled());
        assert!(runtime.grant("second").is_some());
    }

    #[test]
    fn old_listener_cannot_clear_a_new_server_generation() {
        let runtime = McpRuntime::default();
        let (old_tx, _old_rx) = oneshot::channel();
        runtime.set_server("http://127.0.0.1:1/mcp".into(), old_tx);
        let (new_tx, _new_rx) = oneshot::channel();
        runtime.set_server("http://127.0.0.1:2/mcp".into(), new_tx);

        runtime.mark_stopped("http://127.0.0.1:1/mcp");
        assert_eq!(
            runtime.status().0.as_deref(),
            Some("http://127.0.0.1:2/mcp")
        );
    }
}
