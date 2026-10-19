//! Dedicated Redis inspection, stream and Pub/Sub commands.
use crate::db::pool::{DbPool, RedisHandle};
use crate::db::redis_tools as tools;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use crate::secret;
use crate::state::AppState;
use futures::StreamExt;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

const SUB_CHANNEL_CAPACITY: usize = 32;
const MAX_SUBSCRIPTIONS_PER_CONNECTION: usize = 4;
const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_PUBSUB_MESSAGE_BYTES: usize = 24 * 1024;

struct Subscription {
    connection_id: String,
    cancellation: CancellationToken,
    receiver: AsyncMutex<mpsc::Receiver<tools::PubSubMessage>>,
    dropped: Arc<AtomicU64>,
    stopped: Arc<std::sync::atomic::AtomicBool>,
}

fn subscriptions() -> &'static Mutex<HashMap<String, Arc<Subscription>>> {
    static VALUE: OnceLock<Mutex<HashMap<String, Arc<Subscription>>>> = OnceLock::new();
    VALUE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn redis_handle(state: &AppState, id: &str) -> AppResult<RedisHandle> {
    match state.get_pool(id) {
        Some(DbPool::Redis(handle)) => Ok(handle),
        Some(_) => Err(AppError::msg("not a Redis connection")),
        None => Err(AppError::msg("not connected")),
    }
}

fn ensure_writable(state: &AppState, id: &str) -> AppResult<()> {
    if state
        .store
        .get(id)
        .map(|cfg| cfg.read_only)
        .unwrap_or(false)
    {
        return Err(AppError::msg(
            "connection is read-only — Redis writes are blocked",
        ));
    }
    Ok(())
}

/// Construct a new client for Pub/Sub, which cannot share the multiplexed
/// ConnectionManager used by normal request/response commands.
fn pubsub_client(state: &AppState, id: &str) -> AppResult<redis::Client> {
    let mut cfg = state
        .store
        .get(id)
        .ok_or_else(|| AppError::msg("connection not found"))?;
    if cfg.driver != DriverKind::Redis {
        return Err(AppError::msg("not a Redis connection"));
    }
    cfg.password = secret::read_password(id)?;
    let url = if cfg.ssh.is_some() {
        let tunnel = state.tunnels.read().get(id).cloned().ok_or_else(|| {
            AppError::msg("SSH tunnel is not active; connect before starting Pub/Sub")
        })?;
        crate::db::build_url_with(&cfg, Some((&tunnel.local_host, tunnel.local_port)))?
    } else {
        crate::db::build_url_with(&cfg, None)?
    };
    Ok(redis::Client::open(url)?)
}

#[tauri::command]
pub async fn redis_hscan(
    state: State<'_, AppState>,
    id: String,
    key: String,
    cursor: String,
) -> AppResult<tools::ScanPage<tools::HashEntry>> {
    tools::hscan(&redis_handle(&state, &id)?, &key, &cursor).await
}

#[tauri::command]
pub async fn redis_sscan(
    state: State<'_, AppState>,
    id: String,
    key: String,
    cursor: String,
) -> AppResult<tools::ScanPage<String>> {
    tools::sscan(&redis_handle(&state, &id)?, &key, &cursor).await
}

#[tauri::command]
pub async fn redis_xrange(
    state: State<'_, AppState>,
    id: String,
    key: String,
    start: String,
    count: usize,
    reverse: bool,
) -> AppResult<tools::ScanPage<tools::StreamEntry>> {
    tools::xrange(&redis_handle(&state, &id)?, &key, &start, count, reverse).await
}

#[tauri::command]
pub async fn redis_xadd(
    state: State<'_, AppState>,
    id: String,
    key: String,
    fields: Vec<(String, String)>,
) -> AppResult<String> {
    ensure_writable(&state, &id)?;
    tools::xadd(&redis_handle(&state, &id)?, &key, &fields).await
}

#[tauri::command]
pub async fn redis_xdel(
    state: State<'_, AppState>,
    id: String,
    key: String,
    ids: Vec<String>,
) -> AppResult<u64> {
    ensure_writable(&state, &id)?;
    tools::xdel(&redis_handle(&state, &id)?, &key, &ids).await
}

#[tauri::command]
pub async fn redis_xinfo_groups(
    state: State<'_, AppState>,
    id: String,
    key: String,
) -> AppResult<Vec<tools::StreamGroup>> {
    tools::xinfo_groups(&redis_handle(&state, &id)?, &key).await
}

#[tauri::command]
pub async fn redis_xgroup_create(
    state: State<'_, AppState>,
    id: String,
    key: String,
    group: String,
) -> AppResult<()> {
    ensure_writable(&state, &id)?;
    tools::xgroup_create(&redis_handle(&state, &id)?, &key, &group).await
}

#[tauri::command]
pub async fn redis_xgroup_destroy(
    state: State<'_, AppState>,
    id: String,
    key: String,
    group: String,
) -> AppResult<bool> {
    ensure_writable(&state, &id)?;
    tools::xgroup_destroy(&redis_handle(&state, &id)?, &key, &group).await
}

#[tauri::command]
pub async fn redis_cluster_snapshot(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<tools::ClusterSnapshot> {
    tools::cluster_snapshot(&redis_handle(&state, &id)?).await
}

#[tauri::command]
pub async fn redis_list_set_cas(
    state: State<'_, AppState>,
    id: String,
    key: String,
    index: usize,
    expected: String,
    next: String,
) -> AppResult<()> {
    ensure_writable(&state, &id)?;
    tools::list_set_cas(&redis_handle(&state, &id)?, &key, index, &expected, &next).await
}

#[tauri::command]
pub async fn redis_list_delete_cas(
    state: State<'_, AppState>,
    id: String,
    key: String,
    index: usize,
    expected: String,
) -> AppResult<()> {
    ensure_writable(&state, &id)?;
    tools::list_delete_cas(&redis_handle(&state, &id)?, &key, index, &expected).await
}

#[tauri::command]
pub async fn redis_pubsub_start(
    state: State<'_, AppState>,
    id: String,
    channel: String,
) -> AppResult<String> {
    if channel.is_empty() || channel.len() > 1024 {
        return Err(AppError::msg(
            "channel is required and must be at most 1024 bytes",
        ));
    }
    redis_handle(&state, &id)?;
    let generation = state.sessions.lease(&id)?;
    let client = {
        let _lifecycle = crate::state::sqlite_file_operation_lock().lock().await;
        if state.sessions.lease(&id)? != generation {
            return Err(AppError::msg("connection changed while subscribing"));
        }
        pubsub_client(&state, &id)?
    };
    let sub_id = uuid::Uuid::new_v4().to_string();
    let cancellation = CancellationToken::new();
    let (sender, receiver) = mpsc::channel(SUB_CHANNEL_CAPACITY);
    let dropped = Arc::new(AtomicU64::new(0));
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let subscription = Arc::new(Subscription {
        connection_id: id.clone(),
        cancellation: cancellation.clone(),
        receiver: AsyncMutex::new(receiver),
        dropped: dropped.clone(),
        stopped: stopped.clone(),
    });
    {
        let mut guard = subscriptions().lock();
        let count = guard.values().filter(|s| s.connection_id == id).count();
        if count >= MAX_SUBSCRIPTIONS_PER_CONNECTION || guard.len() >= MAX_SUBSCRIPTIONS {
            return Err(AppError::msg("too many active Pub/Sub subscriptions"));
        }
        // Reserve synchronously before awaiting the network handshake so
        // simultaneous starts cannot exceed the per-connection/global caps.
        guard.insert(sub_id.clone(), subscription);
    }

    let mut pubsub = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client.get_async_pubsub(),
    )
    .await
    {
        Ok(Ok(pubsub)) => pubsub,
        Ok(Err(error)) => {
            if let Some(sub) = subscriptions().lock().remove(&sub_id) {
                sub.cancellation.cancel();
            }
            return Err(error.into());
        }
        Err(_) => {
            if let Some(sub) = subscriptions().lock().remove(&sub_id) {
                sub.cancellation.cancel();
            }
            return Err(AppError::msg("Pub/Sub connection timed out"));
        }
    };
    let patterned = channel.chars().any(|c| matches!(c, '*' | '?' | '['));
    let subscribe_result = if patterned {
        pubsub.psubscribe(channel.as_str()).await
    } else {
        pubsub.subscribe(channel.as_str()).await
    };
    if let Err(error) = subscribe_result {
        if let Some(sub) = subscriptions().lock().remove(&sub_id) {
            sub.cancellation.cancel();
        }
        return Err(error.into());
    }

    tokio::spawn(async move {
        let mut stream = pubsub.on_message();
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                item = stream.next() => match item {
                    Some(message) => {
                        let bytes = message.get_payload_bytes();
                        let (payload, binary) = if bytes.len() > MAX_PUBSUB_MESSAGE_BYTES {
                            (format!("[message omitted: {} bytes]", bytes.len()), false)
                        } else {
                            tools::display_bytes(bytes)
                        };
                        let event = tools::PubSubMessage {
                            channel: message.get_channel_name().to_string(),
                            payload,
                            binary,
                            received_at_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
                        };
                        if sender.try_send(event).is_err() {
                            dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    None => break,
                }
            }
        }
        stopped.store(true, Ordering::Release);
    });
    Ok(sub_id)
}

#[tauri::command]
pub async fn redis_pubsub_poll(
    id: String,
    subscription_id: String,
    limit: usize,
) -> AppResult<tools::PubSubBatch> {
    let subscription = subscriptions()
        .lock()
        .get(&subscription_id)
        .cloned()
        .ok_or_else(|| AppError::msg("Pub/Sub subscription not found"))?;
    if subscription.connection_id != id {
        return Err(AppError::msg(
            "Pub/Sub subscription belongs to another connection",
        ));
    }
    let mut receiver = subscription.receiver.lock().await;
    let mut messages = Vec::new();
    for _ in 0..limit.clamp(1, 100) {
        match receiver.try_recv() {
            Ok(message) => messages.push(message),
            Err(_) => break,
        }
    }
    let dropped = subscription.dropped.swap(0, Ordering::AcqRel);
    let stopped = subscription.stopped.load(Ordering::Acquire);
    Ok(tools::PubSubBatch {
        messages,
        dropped,
        stopped,
    })
}

#[tauri::command]
pub fn redis_pubsub_stop(id: String, subscription_id: String) -> AppResult<()> {
    let subscription = {
        let mut registry = subscriptions().lock();
        let subscription = registry
            .get(&subscription_id)
            .ok_or_else(|| AppError::msg("Pub/Sub subscription not found"))?;
        if subscription.connection_id != id {
            return Err(AppError::msg(
                "Pub/Sub subscription belongs to another connection",
            ));
        }
        registry
            .remove(&subscription_id)
            .expect("validated subscription")
    };
    subscription.cancellation.cancel();
    Ok(())
}

/// Called by connection lifecycle handlers to release dedicated Pub/Sub TCP
/// sessions when their owning connection changes or disconnects.
pub fn stop_redis_subscriptions_for_connection(connection_id: &str) {
    let removed = {
        let mut all = subscriptions().lock();
        let ids: Vec<_> = all
            .iter()
            .filter(|(_, s)| s.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| all.remove(&id))
            .collect::<Vec<_>>()
    };
    for subscription in removed {
        subscription.cancellation.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn live_pubsub_delivers_and_disconnect_revokes_the_subscription() {
        use tauri::Manager;
        if std::env::var("RDBSTUDIO_TEST_REDIS_URL").is_err() {
            eprintln!("skipped: Redis live test environment is not set");
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let id = format!("pubsub-test-{}", uuid::Uuid::new_v4());
        let store = crate::store::ConnectionStore::load(directory.path()).unwrap();
        store
            .upsert(crate::model::ConnectionConfig {
                id: id.clone(),
                name: "Live Pub/Sub test".into(),
                driver: crate::model::DriverKind::Redis,
                host: Some("127.0.0.1".into()),
                port: Some(6379),
                database: Some("0".into()),
                username: None,
                file_path: None,
                color: None,
                pinned: false,
                group: None,
                ssl_mode: None,
                read_only: true,
                ssh: None,
                password: None,
            })
            .unwrap();
        let state = AppState::new(
            store,
            crate::history::HistoryStore::load(directory.path()).unwrap(),
            crate::store::SnippetStore::load(directory.path()).unwrap(),
        );
        let client = redis::Client::open("redis://127.0.0.1:6379").unwrap();
        let manager = redis::aio::ConnectionManager::new(client.clone())
            .await
            .unwrap();
        state.insert_pool(
            id.clone(),
            DbPool::Redis(crate::db::pool::RedisHandle::new(manager, 0)),
        );
        state.sessions.mark_connected(&id);
        let app = tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert!(
            redis_xadd(
                app.state(),
                id.clone(),
                "blocked".into(),
                vec![("a".into(), "b".into())]
            )
            .await
            .is_err(),
            "read-only writes must be rejected before reaching Redis"
        );
        let channel = format!("rdbstudio:test:{}", uuid::Uuid::new_v4());
        let subscription = redis_pubsub_start(app.state(), id.clone(), channel.clone())
            .await
            .unwrap();
        let mut publish = client.get_multiplexed_async_connection().await.unwrap();
        let _: i64 = redis::cmd("PUBLISH")
            .arg(&channel)
            .arg("message")
            .query_async(&mut publish)
            .await
            .unwrap();
        let mut delivered = false;
        for _ in 0..100 {
            let messages = redis_pubsub_poll(id.clone(), subscription.clone(), 10)
                .await
                .unwrap();
            if messages
                .messages
                .iter()
                .any(|message| message.payload == "message")
            {
                delivered = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            delivered,
            "a subscribed message must arrive through the bounded queue"
        );
        crate::commands::connections::disconnect(app.state(), id.clone())
            .await
            .unwrap();
        assert!(redis_pubsub_poll(id, subscription, 10).await.is_err());
    }
}
