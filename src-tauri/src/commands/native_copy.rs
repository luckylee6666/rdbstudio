use crate::db::native_copy::{self, CopyPhase, CopyPlan, NativeCopyRequest, ProgressFn};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;
use tokio_util::sync::CancellationToken;

const PREVIEW_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PREVIEWS: usize = 8;
const MAX_OPERATIONS: usize = 4;

struct Preview {
    connection_id: String,
    generation: u64,
    request: NativeCopyRequest,
    fingerprint: String,
    created: Instant,
}
struct Operation {
    cancel: CancellationToken,
    phase: Mutex<CopyPhase>,
    started: Instant,
}

static PREVIEWS: OnceLock<Mutex<HashMap<String, Preview>>> = OnceLock::new();
static OPERATIONS: OnceLock<Mutex<HashMap<String, Arc<Operation>>>> = OnceLock::new();
fn previews() -> &'static Mutex<HashMap<String, Preview>> {
    PREVIEWS.get_or_init(Default::default)
}
fn operations() -> &'static Mutex<HashMap<String, Arc<Operation>>> {
    OPERATIONS.get_or_init(Default::default)
}

#[derive(Serialize)]
pub struct NativeCopyPreview {
    token: String,
    plan: CopyPlan,
}
#[derive(Serialize)]
pub struct NativeCopyResult {
    rows_copied: u64,
    elapsed_ms: u64,
}
#[derive(Serialize)]
pub struct NativeCopyProgress {
    phase: CopyPhase,
    elapsed_ms: u64,
}

struct OperationGuard(String);
impl Drop for OperationGuard {
    fn drop(&mut self) {
        operations().lock().remove(&self.0);
    }
}

// Dropping an IPC response must request cancellation rather than abort the
// database task: MySQL still needs to remove its private staging table.
struct CancelOnDrop(Option<CancellationToken>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(token) = &self.0 {
            token.cancel();
        }
    }
}

#[tauri::command]
pub async fn preview_native_copy(
    state: State<'_, AppState>,
    id: String,
    request: NativeCopyRequest,
) -> AppResult<NativeCopyPreview> {
    let generation = state.sessions.lease(&id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    let plan = native_copy::preview(&pool, &request).await?;
    if serde_json::to_vec(&plan)?.len() > 1024 * 1024 {
        return Err(AppError::msg(
            "table definition exceeds the 1 MiB copy preview budget",
        ));
    }
    if state.sessions.lease(&id)? != generation {
        return Err(AppError::msg(
            "connection changed while previewing; preview again",
        ));
    }
    let token = uuid::Uuid::new_v4().to_string();
    let mut cache = previews().lock();
    cache.retain(|_, value| value.created.elapsed() < PREVIEW_TTL);
    if cache.len() >= MAX_PREVIEWS {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, value)| value.created)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        token.clone(),
        Preview {
            connection_id: id,
            generation,
            request,
            fingerprint: plan.fingerprint.clone(),
            created: Instant::now(),
        },
    );
    Ok(NativeCopyPreview { token, plan })
}

#[tauri::command]
pub async fn apply_native_copy(
    state: State<'_, AppState>,
    token: String,
    operation_id: String,
) -> AppResult<NativeCopyResult> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err(AppError::msg(
            "copy operation id must contain 1 to 128 bytes",
        ));
    }
    let operation = Arc::new(Operation {
        cancel: CancellationToken::new(),
        phase: Mutex::new(CopyPhase::Preparing),
        started: Instant::now(),
    });
    {
        let mut active = operations().lock();
        if active.contains_key(&operation_id) {
            return Err(AppError::msg("copy operation id is already in use"));
        }
        if active.len() >= MAX_OPERATIONS {
            return Err(AppError::msg("too many table copies are running"));
        }
        active.insert(operation_id.clone(), operation.clone());
    }
    let guard = OperationGuard(operation_id);
    let cached = previews()
        .lock()
        .remove(&token)
        .ok_or_else(|| AppError::msg("copy preview expired or was already used; preview again"))?;
    if cached.created.elapsed() >= PREVIEW_TTL {
        return Err(AppError::msg("copy preview expired; preview again"));
    }
    // Capture the pool before validating its generation. A reconnect between
    // validation and capture must never redirect an old preview to a new pool.
    let pool = state
        .get_pool(&cached.connection_id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    if state.sessions.lease(&cached.connection_id)? != cached.generation {
        return Err(AppError::msg(
            "connection changed after preview; preview again",
        ));
    }
    crate::commands::ensure_writable(&state, &cached.connection_id)?;
    let progress_state = operation.clone();
    let progress: ProgressFn = Arc::new(move |phase| {
        let mut current = progress_state.phase.lock();
        *current = if progress_state.cancel.is_cancelled() {
            CopyPhase::Cancelling
        } else {
            phase
        };
    });
    let mut cancel_on_drop = CancelOnDrop(Some(operation.cancel.clone()));
    let task = tokio::spawn(async move {
        let _guard = guard;
        let result = native_copy::execute(
            &pool,
            &cached.request,
            &cached.fingerprint,
            operation.cancel.clone(),
            progress,
        )
        .await?;
        Ok::<_, AppError>(NativeCopyResult {
            rows_copied: result.rows_copied,
            elapsed_ms: operation.started.elapsed().as_millis() as u64,
        })
    });
    let result = task
        .await
        .map_err(|error| AppError::msg(format!("table copy task failed: {error}")))?;
    cancel_on_drop.0 = None;
    result
}

#[tauri::command]
pub fn native_copy_progress(operation_id: String) -> Option<NativeCopyProgress> {
    let operation = operations().lock().get(&operation_id)?.clone();
    let phase = *operation.phase.lock();
    Some(NativeCopyProgress {
        phase,
        elapsed_ms: operation.started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub fn cancel_native_copy(operation_id: String) -> bool {
    let Some(operation) = operations().lock().get(&operation_id).cloned() else {
        return false;
    };
    let mut phase = operation.phase.lock();
    if *phase == CopyPhase::Finishing {
        return false;
    }
    operation.cancel.cancel();
    *phase = CopyPhase::Cancelling;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_refused_once_publication_starts() {
        let id = uuid::Uuid::new_v4().to_string();
        let operation = Arc::new(Operation {
            cancel: CancellationToken::new(),
            phase: Mutex::new(CopyPhase::Finishing),
            started: Instant::now(),
        });
        operations().lock().insert(id.clone(), operation.clone());
        let _guard = OperationGuard(id.clone());
        assert!(!cancel_native_copy(id.clone()));
        assert!(!operation.cancel.is_cancelled());
        *operation.phase.lock() = CopyPhase::Copying;
        assert!(cancel_native_copy(id));
        assert!(operation.cancel.is_cancelled());
        assert_eq!(*operation.phase.lock(), CopyPhase::Cancelling);
    }

    #[test]
    fn dropping_the_response_requests_cleanup_instead_of_aborting_work() {
        let token = CancellationToken::new();
        let guard = CancelOnDrop(Some(token.clone()));
        drop(guard);
        assert!(token.is_cancelled());
    }
}
