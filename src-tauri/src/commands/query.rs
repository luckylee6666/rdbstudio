use crate::db::exec::{execute, QueryResult, ScriptOutcome};
use crate::error::{AppError, AppResult};
use crate::history::HistoryEntry;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
    query_id: Option<String>,
) -> AppResult<QueryResult> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;

    // Connection-level read-only mode: classify the statement and reject
    // writes before anything reaches the driver. SQL uses the same detector
    // as the result-shape branch; Redis gets a command whitelist.
    if state.store.get(&id).map(|c| c.read_only).unwrap_or(false) {
        let readonly_stmt = match &pool {
            crate::db::pool::DbPool::Redis(_) => crate::db::redis_ops::line_is_readonly(&sql),
            _ => crate::db::exec::is_readonly(&sql),
        };
        if !readonly_stmt {
            return Err(AppError::msg(
                "connection is read-only — write statements are blocked",
            ));
        }
    }

    let at = chrono::Utc::now().to_rfc3339();

    // Run the query on its own task so `cancel_query` can abort it mid-flight.
    // Aborting drops the sqlx future; the underlying connection is closed
    // rather than returned to the pool, which is the safe teardown.
    let task_sql = sql.clone();
    let task = tokio::spawn(async move { execute(&pool, &task_sql).await });
    if let Some(qid) = query_id.as_deref() {
        state.register_query(qid, task.abort_handle());
    }
    let result = match task.await {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Err(AppError::msg("query cancelled")),
        Err(e) => Err(AppError::msg(format!("query task failed: {e}"))),
    };
    if let Some(qid) = query_id.as_deref() {
        state.unregister_query(qid);
    }

    let entry = match &result {
        Ok(r) => HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: id.clone(),
            sql: sql.clone(),
            elapsed_ms: r.elapsed_ms,
            row_count: Some(r.rows.len() as u64),
            rows_affected: r.rows_affected,
            error: None,
            at: at.clone(),
        },
        Err(e) => HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: id.clone(),
            sql: sql.clone(),
            elapsed_ms: 0,
            row_count: None,
            rows_affected: None,
            error: Some(e.to_string()),
            at: at.clone(),
        },
    };
    let _ = state.history.push(entry);

    result
}

/// Atomic multi-statement execution: the whole script runs inside one backend
/// transaction (the editor's per-statement loop each autocommitted, so a
/// mid-script failure left earlier statements applied). Cancel/read-only/history
/// semantics mirror `execute_query`.
#[tauri::command]
pub async fn execute_script(
    state: State<'_, AppState>,
    id: String,
    sqls: Vec<String>,
    query_id: Option<String>,
) -> AppResult<ScriptOutcome> {
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;

    if state.store.get(&id).map(|c| c.read_only).unwrap_or(false) {
        let all_readonly = match &pool {
            crate::db::pool::DbPool::Redis(_) => sqls
                .iter()
                .all(|s| crate::db::redis_ops::line_is_readonly(s)),
            _ => sqls.iter().all(|s| crate::db::exec::is_readonly(s)),
        };
        if !all_readonly {
            return Err(AppError::msg(
                "connection is read-only — write statements are blocked",
            ));
        }
    }

    let at = chrono::Utc::now().to_rfc3339();
    let joined = sqls.join(";\n");

    let task_sqls = sqls.clone();
    let task = tokio::spawn(async move { crate::db::exec::execute_script(&pool, &task_sqls).await });
    if let Some(qid) = query_id.as_deref() {
        state.register_query(qid, task.abort_handle());
    }
    let result = match task.await {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Err(AppError::msg("query cancelled")),
        Err(e) => Err(AppError::msg(format!("query task failed: {e}"))),
    };
    if let Some(qid) = query_id.as_deref() {
        state.unregister_query(qid);
    }

    // One history entry for the whole script.
    let entry = match &result {
        Ok(ScriptOutcome::Ok {
            result: r,
            total_affected,
            ..
        }) => HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: id.clone(),
            sql: joined.clone(),
            elapsed_ms: r.elapsed_ms,
            row_count: Some(r.rows.len() as u64),
            rows_affected: Some(*total_affected),
            error: None,
            at: at.clone(),
        },
        Ok(ScriptOutcome::Failed {
            failed_index,
            statements,
            error,
        }) => HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: id.clone(),
            sql: joined.clone(),
            elapsed_ms: 0,
            row_count: None,
            rows_affected: None,
            error: Some(format!(
                "statement {}/{}: {} (rolled back)",
                failed_index + 1,
                statements,
                error
            )),
            at: at.clone(),
        },
        Err(e) => HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: id.clone(),
            sql: joined.clone(),
            elapsed_ms: 0,
            row_count: None,
            rows_affected: None,
            error: Some(e.to_string()),
            at: at.clone(),
        },
    };
    let _ = state.history.push(entry);

    result
}

/// Atomic rename of a hash field / set member / zset member. The old frontend
/// flow issued delete-then-add command pairs, which could clobber an existing
/// target or drop the value on a race — this goes through a guarded Lua script.
#[tauri::command]
pub async fn redis_rename_member(
    state: State<'_, AppState>,
    id: String,
    key: String,
    kind: String,
    old_name: String,
    new_name: String,
) -> AppResult<()> {
    crate::commands::ensure_writable(&state, &id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    match &pool {
        crate::db::pool::DbPool::Redis(h) => {
            crate::db::redis_ops::rename_member(h, &key, &kind, &old_name, &new_name).await
        }
        _ => Err(AppError::msg("not a Redis connection")),
    }
}

#[tauri::command]
pub fn cancel_query(state: State<'_, AppState>, query_id: String) -> bool {
    state.cancel_query(&query_id)
}

#[tauri::command]
pub fn list_history(state: State<'_, AppState>, limit: Option<usize>) -> Vec<HistoryEntry> {
    state.history.list(limit.unwrap_or(100))
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> AppResult<()> {
    state.history.clear()
}
