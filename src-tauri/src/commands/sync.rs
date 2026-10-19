use crate::db::pool::DbPool;
use crate::db::sync::{
    self, ConflictPolicy, SearchRequest, SearchResult, SyncPreview, SyncReport, SyncRequest,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;

const PREVIEW_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PREVIEWS: usize = 8;

struct CachedPreview {
    request: SyncRequest,
    digest: u64,
    source_digest: u64,
    source_generation: u64,
    target_generation: u64,
    created: Instant,
}

static PREVIEWS: OnceLock<Mutex<HashMap<String, CachedPreview>>> = OnceLock::new();

fn previews() -> &'static Mutex<HashMap<String, CachedPreview>> {
    PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyDataOptions {
    pub policy: ConflictPolicy,
    /// Create a missing target table from the previewed portable plan before
    /// inserting rows. Existing-table schema changes require applying the
    /// structure plan, then generating a fresh data preview.
    #[serde(default)]
    pub create_missing_table: bool,
}

fn get_pool(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .get_pool(id)
        .ok_or_else(|| AppError::msg(format!("connection {} is not connected", id)))
}

fn cache(
    request: SyncRequest,
    digest: u64,
    source_digest: u64,
    source_generation: u64,
    target_generation: u64,
) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    let mut entries = previews().lock().expect("sync preview cache poisoned");
    let now = Instant::now();
    entries.retain(|_, e| now.duration_since(e.created) < PREVIEW_TTL);
    if entries.len() >= MAX_PREVIEWS {
        if let Some(oldest) = entries
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(token, _)| token.clone())
        {
            entries.remove(&oldest);
        }
    }
    entries.insert(
        token.clone(),
        CachedPreview {
            request,
            digest,
            source_digest,
            source_generation,
            target_generation,
            created: now,
        },
    );
    token
}

fn take_cached(token: &str) -> AppResult<CachedPreview> {
    let cached = previews()
        .lock()
        .expect("sync preview cache poisoned")
        .remove(token)
        .ok_or_else(|| AppError::msg("sync preview expired or already used; preview again"))?;
    if cached.created.elapsed() >= PREVIEW_TTL {
        return Err(AppError::msg("sync preview expired; preview again"));
    }
    Ok(cached)
}

fn ensure_preview_connections(
    state: &AppState,
    request: &SyncRequest,
    source_generation: u64,
    target_generation: u64,
) -> AppResult<()> {
    if state.sessions.lease(&request.source_id)? != source_generation
        || state.sessions.lease(&request.target_id)? != target_generation
    {
        return Err(AppError::msg(
            "source or target connection changed after preview; preview again",
        ));
    }
    crate::commands::ensure_writable(state, &request.target_id)
}

async fn current_plan(
    state: &AppState,
    request: SyncRequest,
) -> AppResult<(DbPool, DbPool, sync::SyncPlan)> {
    let source = get_pool(state, &request.source_id)?;
    let target = get_pool(state, &request.target_id)?;
    let plan = sync::preview(&source, &target, request).await?;
    Ok((source, target, plan))
}

#[tauri::command]
pub async fn preview_sync(
    state: State<'_, AppState>,
    request: SyncRequest,
) -> AppResult<SyncPreview> {
    if request.source_id.len() > 128
        || request.target_id.len() > 128
        || request.source_table.len() > 256
        || request.target_table.len() > 256
        || request
            .source_schema
            .as_deref()
            .is_some_and(|s| s.len() > 256)
        || request
            .target_schema
            .as_deref()
            .is_some_and(|s| s.len() > 256)
    {
        return Err(AppError::msg(
            "sync connection and object names exceed the supported length",
        ));
    }
    let source_generation = state.sessions.lease(&request.source_id)?;
    let target_generation = state.sessions.lease(&request.target_id)?;
    let (_, _, plan) = current_plan(&state, request.clone()).await?;
    let token = cache(
        request,
        plan.digest,
        plan.source_digest,
        source_generation,
        target_generation,
    );
    Ok(SyncPreview {
        token,
        source_driver: plan.source_driver,
        target_driver: plan.target_driver,
        structure: plan.structure.clone(),
        data_supported: plan.data_supported,
        data_reason: plan.data_reason.clone(),
        counts: plan.counts.clone(),
        rows_examined: plan.rows_examined,
        bytes_examined: plan.bytes_examined,
    })
}

#[tauri::command]
pub async fn apply_structure_sync(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<SyncReport> {
    let cached = take_cached(&token)?;
    apply_structure_sync_inner(&state, cached).await
}

async fn apply_structure_sync_inner(
    state: &AppState,
    cached: CachedPreview,
) -> AppResult<SyncReport> {
    ensure_preview_connections(
        state,
        &cached.request,
        cached.source_generation,
        cached.target_generation,
    )?;
    let (_, target, plan) = current_plan(state, cached.request).await?;
    // Capturing pools and re-reading metadata both happen after the first
    // validation. A reconnect or read-only change during either step must not
    // authorize an old preview against another connection or configuration.
    ensure_preview_connections(
        state,
        &plan.request,
        cached.source_generation,
        cached.target_generation,
    )?;
    if plan.digest != cached.digest {
        return Err(AppError::msg(
            "source or target data changed after preview; preview again",
        ));
    }
    if !plan.structure.supported {
        return Err(AppError::msg(
            plan.structure
                .reason
                .unwrap_or_else(|| "unsupported structure difference".into()),
        ));
    }
    let count = sync::apply_structure(&target, &plan.structure).await?;
    Ok(SyncReport {
        inserted: 0,
        updated: 0,
        deleted: 0,
        structure_statements: count,
        structure_applied_before_data: false,
        transactional: plan.structure.ddl_transactional,
    })
}

#[tauri::command]
pub async fn apply_data_sync(
    state: State<'_, AppState>,
    token: String,
    options: ApplyDataOptions,
) -> AppResult<SyncReport> {
    let cached = take_cached(&token)?;
    apply_data_sync_inner(&state, cached, options).await
}

async fn apply_data_sync_inner(
    state: &AppState,
    cached: CachedPreview,
    options: ApplyDataOptions,
) -> AppResult<SyncReport> {
    ensure_preview_connections(
        state,
        &cached.request,
        cached.source_generation,
        cached.target_generation,
    )?;
    if options.policy == ConflictPolicy::Mirror && !cached.request.compare_deletes {
        return Err(AppError::msg(
            "preview target-only rows before choosing mirror mode",
        ));
    }
    let (source, target, mut plan) = current_plan(state, cached.request).await?;
    ensure_preview_connections(
        state,
        &plan.request,
        cached.source_generation,
        cached.target_generation,
    )?;
    if plan.digest != cached.digest {
        return Err(AppError::msg(
            "source or target data changed after preview; preview again",
        ));
    }
    let mut structure_count = 0;
    let mut structure_applied = false;
    if !plan.structure.statements.is_empty() {
        if plan.structure.target_exists {
            return Err(AppError::msg(
                "apply the reviewed schema changes separately, then preview data again",
            ));
        }
        if !options.create_missing_table {
            return Err(AppError::msg(
                "target table is missing; enable create target table",
            ));
        }
        structure_count = sync::apply_structure(&target, &plan.structure).await?;
        structure_applied = true;
        // Re-read target metadata and rows after CREATE TABLE. A create-only
        // structure change is the only DDL that may be combined with data.
        let request = plan.request.clone();
        // Keep both captured pools: looking up source_id again can select a
        // newly connected database while target still refers to the old one.
        plan = match sync::preview(&source, &target, request).await {
            Ok(plan) => plan,
            Err(error) => {
                return Err(AppError::msg(format!(
                    "target table structure was created before data preview failed: {error}"
                )))
            }
        };
        if plan.source_digest != cached.source_digest {
            return Err(AppError::msg(
                "source rows changed while creating the target table; preview again before transfer",
            ));
        }
    }
    if let Err(error) = ensure_preview_connections(
        state,
        &plan.request,
        cached.source_generation,
        cached.target_generation,
    ) {
        return Err(if structure_applied {
            AppError::msg(format!(
                "target structure was applied before data synchronization was blocked: {error}"
            ))
        } else {
            error
        });
    }
    let (inserted, updated, deleted) = match sync::apply_data(&target, &plan, options.policy).await
    {
        Ok(result) => result,
        Err(error) if structure_applied => {
            return Err(AppError::msg(format!(
                "target structure was applied before data synchronization failed: {error}"
            )))
        }
        Err(error) => return Err(error),
    };
    Ok(SyncReport {
        inserted,
        updated,
        deleted,
        structure_statements: structure_count,
        structure_applied_before_data: structure_applied,
        transactional: !structure_applied,
    })
}

#[tauri::command]
pub async fn search_global_data(
    state: State<'_, AppState>,
    request: SearchRequest,
) -> AppResult<SearchResult> {
    let pool = get_pool(&state, &request.connection_id)?;
    sync::search(&pool, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::Notify;

    async fn sqlite_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    fn state(directory: &std::path::Path, source: &SqlitePool, target: &SqlitePool) -> AppState {
        let store = crate::store::ConnectionStore::load(directory).unwrap();
        store
            .upsert(
                serde_json::from_value(serde_json::json!({
                    "id": "target", "name": "Sync race target", "driver": "sqlite"
                }))
                .unwrap(),
            )
            .unwrap();
        let state = AppState::new(
            store,
            crate::history::HistoryStore::load(directory).unwrap(),
            crate::store::SnippetStore::load(directory).unwrap(),
        );
        state.insert_pool("source".into(), DbPool::Sqlite(source.clone()));
        state.insert_pool("target".into(), DbPool::Sqlite(target.clone()));
        state.sessions.mark_connected("source");
        state.sessions.mark_connected("target");
        state
    }

    fn request() -> SyncRequest {
        SyncRequest {
            source_id: "source".into(),
            target_id: "target".into(),
            source_schema: None,
            target_schema: None,
            source_table: "source".into(),
            target_table: "target".into(),
            compare_deletes: false,
        }
    }

    async fn cached(state: &AppState) -> CachedPreview {
        let (_, _, plan) = current_plan(state, request()).await.unwrap();
        CachedPreview {
            request: plan.request,
            digest: plan.digest,
            source_digest: plan.source_digest,
            source_generation: state.sessions.lease("source").unwrap(),
            target_generation: state.sessions.lease("target").unwrap(),
            created: Instant::now(),
        }
    }

    async fn create_source(pool: &SqlitePool) {
        sqlx::raw_sql("CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO source VALUES (1, 'reviewed');")
            .execute(pool).await.unwrap();
    }

    async fn target_unchanged(pool: &SqlitePool, target_exists: bool) {
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'target'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(exists != 0, target_exists);
        if target_exists {
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM target")
                    .fetch_one(pool)
                    .await
                    .unwrap(),
                0,
                "rejected apply must not write rows"
            );
        }
    }

    #[derive(Clone, Copy, Debug)]
    enum Change {
        Source,
        Target,
        ReadOnly,
    }

    async fn rejects_change_during_repreview(data: bool, change: Change) {
        let directory = tempfile::tempdir().unwrap();
        let source = sqlite_pool().await;
        let target = sqlite_pool().await;
        create_source(&source).await;
        if data {
            sqlx::query("CREATE TABLE target (id INTEGER PRIMARY KEY, value TEXT)")
                .execute(&target)
                .await
                .unwrap();
        }
        let state = state(directory.path(), &source, &target);
        let cached = cached(&state).await;
        let replacement = sqlite_pool().await;
        match change {
            Change::Source => create_source(&replacement).await,
            Change::Target if data => {
                sqlx::query("CREATE TABLE target (id INTEGER PRIMARY KEY, value TEXT)")
                    .execute(&replacement)
                    .await
                    .unwrap();
            }
            _ => {}
        }

        // Hold the sole source connection, then poll the actual apply path.
        // Its initial authorization has succeeded and its captured pools are
        // now waiting for the source metadata query, before any target write.
        let blocker = source.acquire().await.unwrap();
        let operation = async {
            if data {
                apply_data_sync_inner(
                    &state,
                    cached,
                    ApplyDataOptions {
                        policy: ConflictPolicy::InsertOnly,
                        create_missing_table: false,
                    },
                )
                .await
            } else {
                apply_structure_sync_inner(&state, cached).await
            }
        };
        tokio::pin!(operation);
        assert!(futures::poll!(&mut operation).is_pending());
        match change {
            Change::Source => {
                state.insert_pool("source".into(), DbPool::Sqlite(replacement.clone()));
                state.sessions.mark_connected("source");
            }
            Change::Target => {
                state.insert_pool("target".into(), DbPool::Sqlite(replacement.clone()));
                state.sessions.mark_connected("target");
            }
            Change::ReadOnly => {
                let mut config = state.store.get("target").unwrap();
                config.read_only = true;
                state.store.upsert(config).unwrap();
            }
        }
        drop(blocker);
        let error = operation.await.unwrap_err().to_string();
        match change {
            Change::ReadOnly => assert!(error.contains("read-only"), "{error}"),
            _ => assert!(error.contains("connection changed"), "{error}"),
        }
        target_unchanged(&target, data).await;
        if matches!(change, Change::Target) {
            target_unchanged(&replacement, data).await;
        }
    }

    #[tokio::test]
    async fn structure_apply_rechecks_connections_and_readonly_after_async_preview() {
        for change in [Change::Source, Change::Target, Change::ReadOnly] {
            rejects_change_during_repreview(false, change).await;
        }
    }

    #[tokio::test]
    async fn data_apply_rechecks_connections_and_readonly_after_async_preview() {
        for change in [Change::Source, Change::Target, Change::ReadOnly] {
            rejects_change_during_repreview(true, change).await;
        }
    }

    #[derive(Default)]
    struct RepreviewGate {
        armed: AtomicBool,
        entered: Notify,
        release: Notify,
    }

    #[tokio::test]
    async fn reconnect_during_post_create_preview_blocks_rows_and_reports_created_structure() {
        let directory = tempfile::tempdir().unwrap();
        let target = sqlite_pool().await;
        let gate = Arc::new(RepreviewGate::default());
        let hook_target = target.clone();
        let hook_gate = gate.clone();
        let source = SqlitePoolOptions::new()
            .max_connections(1)
            .before_acquire(move |_, _| {
                let target = hook_target.clone();
                let gate = hook_gate.clone();
                Box::pin(async move {
                    if gate.armed.load(Ordering::Acquire) {
                        let exists: i64 = sqlx::query_scalar(
                            "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'target'",
                        )
                        .fetch_one(&target)
                        .await?;
                        if exists != 0 && gate.armed.swap(false, Ordering::AcqRel) {
                            gate.entered.notify_one();
                            gate.release.notified().await;
                        }
                    }
                    Ok(true)
                })
            })
            .connect("sqlite::memory:")
            .await
            .unwrap();
        create_source(&source).await;
        let state = state(directory.path(), &source, &target);
        let cached = cached(&state).await;
        let replacement = sqlite_pool().await;
        create_source(&replacement).await;
        gate.armed.store(true, Ordering::Release);
        let operation = apply_data_sync_inner(
            &state,
            cached,
            ApplyDataOptions {
                policy: ConflictPolicy::InsertOnly,
                create_missing_table: true,
            },
        );
        tokio::pin!(operation);
        tokio::select! {
            _ = gate.entered.notified() => {},
            result = &mut operation => panic!("apply finished before post-create preview: {result:?}"),
            _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("post-create preview did not reach the gate"),
        }
        state.insert_pool("source".into(), DbPool::Sqlite(replacement));
        state.sessions.mark_connected("source");
        gate.release.notify_one();
        let error = operation.await.unwrap_err().to_string();
        assert!(error.contains("target structure was applied"), "{error}");
        assert!(error.contains("connection changed"), "{error}");
        target_unchanged(&target, true).await;
    }
}
