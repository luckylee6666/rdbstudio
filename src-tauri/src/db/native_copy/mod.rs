//! Same-connection table copies that keep row values inside the database.

pub mod mysql;
pub mod postgres;
pub mod sqlite;

use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeCopyRequest {
    pub schema: Option<String>,
    pub source_table: String,
    pub target_table: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopyPlan {
    #[serde(skip)]
    pub fingerprint: String,
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
    pub transactional: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyPhase {
    Preparing,
    Creating,
    Copying,
    /// Publication starts here. The IPC cancellation endpoint no longer
    /// accepts new cancellation requests once this phase is reached.
    Finishing,
    Cancelling,
}

pub type ProgressFn = Arc<dyn Fn(CopyPhase) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
pub struct CopyReport {
    pub rows_copied: u64,
}

pub fn fingerprint(value: &str) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

pub fn cancelled() -> AppError {
    AppError::msg("table copy cancelled")
}

fn validate_request(request: &NativeCopyRequest) -> AppResult<()> {
    if request.source_table.trim().is_empty() || request.target_table.trim().is_empty() {
        return Err(AppError::msg("source and target table names are required"));
    }
    for name in [&request.source_table, &request.target_table]
        .into_iter()
        .chain(request.schema.iter())
    {
        if name.len() > 1024 || name.contains('\0') {
            return Err(AppError::msg(
                "table copy identifiers are too long or contain NUL",
            ));
        }
    }
    if request
        .source_table
        .eq_ignore_ascii_case(&request.target_table)
    {
        return Err(AppError::msg("copy target must be a different new table"));
    }
    Ok(())
}

pub async fn preview(pool: &DbPool, request: &NativeCopyRequest) -> AppResult<CopyPlan> {
    validate_request(request)?;
    match pool {
        DbPool::Sqlite(pool) => sqlite::preview(pool, request).await,
        DbPool::Postgres(pool) => postgres::preview(pool, request).await,
        DbPool::Mysql(pool) => mysql::preview(pool, request).await,
        DbPool::Redis(_) => Err(AppError::msg("native table copy does not support Redis")),
    }
}

pub async fn execute(
    pool: &DbPool,
    request: &NativeCopyRequest,
    expected: &str,
    cancel: CancellationToken,
    progress: ProgressFn,
) -> AppResult<CopyReport> {
    validate_request(request)?;
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    match pool {
        DbPool::Sqlite(pool) => sqlite::execute(pool, request, expected, cancel, progress).await,
        DbPool::Postgres(pool) => {
            postgres::execute(pool, request, expected, cancel, progress).await
        }
        DbPool::Mysql(pool) => mysql::execute(pool, request, expected, cancel, progress).await,
        DbPool::Redis(_) => Err(AppError::msg("native table copy does not support Redis")),
    }
}
