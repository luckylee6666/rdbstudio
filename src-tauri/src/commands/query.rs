use crate::db::exec::{execute, QueryResult};
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
