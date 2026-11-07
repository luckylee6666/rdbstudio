use crate::db::{
    exec::{QueryResult, ScriptOutcome},
    parameters::{self, QueryParameter, Syntax},
    sessions::ExecutionOptions,
};
use crate::error::{AppError, AppResult};
use crate::history::HistoryEntry;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

async fn registered<T: Send + 'static>(
    state: &AppState,
    query_id: Option<&str>,
    work: impl std::future::Future<Output = AppResult<T>> + Send + 'static,
) -> AppResult<T> {
    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        if start_rx.await.is_err() {
            return Err(AppError::msg("query cancelled"));
        }
        work.await
    });
    if let Some(qid) = query_id {
        if !state.register_query(qid, task.abort_handle()) {
            task.abort();
            return Err(AppError::msg("query id is already in use"));
        }
    }
    let _ = start_tx.send(());
    let result = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err(AppError::msg("query cancelled")),
        Err(error) => Err(AppError::msg(format!("query task failed: {error}"))),
    };
    if let Some(qid) = query_id {
        state.unregister_query(qid);
    }
    result
}

/// Inspect quoting rules on the same editor session that will execute the SQL.
#[derive(Serialize)]
pub struct ParameterAnalysis {
    names: Vec<String>,
    generation: u64,
}

#[tauri::command]
pub async fn query_parameter_names(
    state: State<'_, AppState>,
    id: String,
    sqls: Vec<String>,
    session_id: Option<String>,
    query_id: Option<String>,
    source_script: Option<bool>,
    future_sets: Option<bool>,
) -> AppResult<ParameterAnalysis> {
    if sqls.is_empty() || sqls.len() > 128 {
        return Err(AppError::msg("scripts must contain 1 to 128 statements"));
    }
    let source_script = source_script.unwrap_or(false);
    if source_script {
        if sqls.len() != 1 {
            return Err(AppError::msg(
                "a source script needs exactly one SQL buffer",
            ));
        }
        crate::db::sql_script::validate_source(&sqls[0])?;
    }
    let generation = state.sessions.lease(&id)?;
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    let driver = parameters::driver_of(&pool);
    if driver == crate::model::DriverKind::Redis {
        return Err(AppError::msg("Redis does not support SQL parameters"));
    }
    let readonly = state.store.get(&id).is_some_and(|config| config.read_only);
    let sessions = Arc::clone(&state.sessions);
    registered(&state, query_id.as_deref(), async move {
        let syntax = if let Some(query) = parameters::setting_query(driver) {
            let result: QueryResult = if let Some(session_id) = session_id.filter(|_| !readonly) {
                match sessions
                    .execute(
                        &id,
                        &session_id,
                        generation,
                        &pool,
                        &[query.to_owned()],
                        false,
                    )
                    .await?
                {
                    ScriptOutcome::Ok { result, .. } => result,
                    ScriptOutcome::Failed { error, .. } => return Err(AppError::msg(error)),
                }
            } else {
                crate::db::exec::execute_readonly(&pool, query).await?
            };
            let setting = result
                .rows
                .first()
                .and_then(|row| row.first())
                .and_then(|value| value.as_str())
                .ok_or_else(|| AppError::msg("could not inspect SQL string mode"))?;
            Syntax::from_setting(driver, setting)
        } else {
            Syntax::default_for(driver)
        };
        Ok(ParameterAnalysis {
            names: if source_script {
                crate::db::sql_script::analyze_with_modes(
                    &sqls[0],
                    syntax,
                    None,
                    future_sets.unwrap_or(false),
                )?
                .names
            } else {
                parameters::parameter_names(&sqls, syntax)?
            },
            generation,
        })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterRequest {
    #[serde(default)]
    pub source_script: bool,
    pub sqls: Vec<String>,
    pub parameters: Vec<QueryParameter>,
    pub query_id: Option<String>,
    pub session_id: Option<String>,
    pub atomic: bool,
    pub generation: Option<u64>,
}

#[tauri::command]
pub async fn execute_parameter_query(
    state: State<'_, AppState>,
    id: String,
    request: ParameterRequest,
) -> AppResult<ScriptOutcome> {
    execute_request(state, id, request, None)
        .await
        .map(|outcome| outcome.outcome)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchParameterRequest {
    pub source: String,
    pub sets: Vec<Vec<QueryParameter>>,
    pub atomic: bool,
    pub query_id: Option<String>,
    pub session_id: Option<String>,
    pub generation: Option<u64>,
}

#[tauri::command]
pub async fn execute_parameter_batch(
    state: State<'_, AppState>,
    id: String,
    request: BatchParameterRequest,
) -> AppResult<crate::db::parameter_batch::Outcome> {
    execute_request(
        state,
        id,
        ParameterRequest {
            source_script: true,
            sqls: vec![request.source],
            parameters: vec![],
            atomic: request.atomic,
            query_id: request.query_id,
            session_id: request.session_id,
            generation: request.generation,
        },
        Some(request.sets),
    )
    .await
}

async fn execute_request(
    state: State<'_, AppState>,
    id: String,
    request: ParameterRequest,
    sets: Option<Vec<Vec<QueryParameter>>>,
) -> AppResult<crate::db::parameter_batch::Outcome> {
    if request.sqls.is_empty() || request.sqls.len() > 128 {
        return Err(AppError::msg("scripts must contain 1 to 128 statements"));
    }
    if request.source_script {
        if request.sqls.len() != 1 {
            return Err(AppError::msg(
                "a source script needs exactly one SQL buffer",
            ));
        }
        crate::db::sql_script::validate_source(&request.sqls[0])?;
    }
    let active_generation = state.sessions.lease(&id)?;
    if request
        .generation
        .is_some_and(|expected| expected != active_generation)
    {
        return Err(AppError::msg(
            "connection changed while entering parameters; run the query again",
        ));
    }
    let pool = state
        .get_pool(&id)
        .ok_or_else(|| AppError::msg("not connected"))?;
    let driver = parameters::driver_of(&pool);
    if driver == crate::model::DriverKind::Redis {
        return Err(AppError::msg("Redis does not support SQL parameters"));
    }
    parameters::validate_values(&request.parameters, driver)?;
    if let Some(sets) = &sets {
        crate::db::parameter_batch::validate(&request.sqls[0], sets, driver)?;
    }
    let readonly = state.store.get(&id).is_some_and(|config| config.read_only);
    let temporary = readonly || request.session_id.is_none();
    // Use the application registry even for short-lived sessions: it owns
    // SQLite's in-memory anchor and connection-generation cancellation.
    let sessions = Arc::clone(&state.sessions);
    let generation = active_generation;
    let session_id = if temporary {
        uuid::Uuid::new_v4().to_string()
    } else {
        request.session_id.expect("checked session")
    };
    let cleanup_session = temporary.then(|| session_id.clone());
    let at = chrono::Utc::now().to_rfc3339();
    let template = request.sqls.join(";\n");
    let has_parameters = sets.is_some() || !request.parameters.is_empty();
    let task_id = id.clone();
    let result = registered(&state, request.query_id.as_deref(), async move {
        let mut progress = crate::db::parameter_batch::Progress::default();
        let outcome = sessions
            .execute_with_options(
                &task_id,
                &session_id,
                generation,
                &pool,
                &request.sqls,
                ExecutionOptions {
                    parameters: Some(&request.parameters),
                    atomic: request.atomic,
                    readonly,
                    source: request.source_script,
                    batch: sets
                        .as_deref()
                        .map(|sets| crate::db::parameter_batch::Execution {
                            sets,
                            progress: &mut progress,
                        }),
                },
            )
            .await?;
        Ok(crate::db::parameter_batch::Outcome { outcome, progress })
    })
    .await;
    // Cancellation aborts the worker, so temporary-session cleanup belongs
    // outside that worker and must also run after a cancelled task.
    if let Some(session_id) = cleanup_session {
        state.sessions.close(&session_id).await;
    }
    // Save the reusable template only. Driver errors can echo a bound value,
    // so persisted failure details must also exclude the server's raw message.
    let (elapsed_ms, row_count, rows_affected, error) =
        match result.as_ref().map(|result| &result.outcome) {
            Ok(ScriptOutcome::Ok {
                result,
                total_affected,
                ..
            }) => (
                result.elapsed_ms,
                Some(result.rows.len() as u64),
                Some(*total_affected),
                None,
            ),
            _ => (
                0,
                None,
                None,
                Some(if has_parameters {
                    "parameterized query failed; parameter values are not recorded".to_owned()
                } else {
                    match result.as_ref().map(|result| &result.outcome) {
                        Ok(ScriptOutcome::Failed { error, .. }) => error.clone(),
                        Err(error) => error.to_string(),
                        _ => unreachable!(),
                    }
                }),
            ),
        };
    let _ = state.history.push(HistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: id,
        sql: template,
        elapsed_ms,
        row_count,
        rows_affected,
        error,
        at,
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{parameters::ParameterKind, pool::DbPool};
    use tauri::Manager;

    async fn app(readonly: bool) -> (tempfile::TempDir, tauri::App<tauri::test::MockRuntime>) {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::ConnectionStore::load(directory.path()).unwrap();
        store.upsert(serde_json::from_value(serde_json::json!({ "id": "c", "name": "test", "driver": "sqlite", "read_only": readonly })).unwrap()).unwrap();
        let state = AppState::new(
            store,
            crate::history::HistoryStore::load(directory.path()).unwrap(),
            crate::store::SnippetStore::load(directory.path()).unwrap(),
        );
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE saved(value TEXT UNIQUE)")
            .execute(&pool)
            .await
            .unwrap();
        state.insert_pool("c".into(), DbPool::Sqlite(pool));
        state.sessions.mark_connected("c");
        let app = tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        (directory, app)
    }
    fn request(sql: &str) -> ParameterRequest {
        ParameterRequest {
            source_script: false,
            sqls: vec![sql.into()],
            parameters: vec![QueryParameter {
                name: "delete".into(),
                kind: ParameterKind::Text,
                value: Some("private-bound-value".into()),
            }],
            query_id: Some("q".into()),
            session_id: Some("tab".into()),
            atomic: false,
            generation: None,
        }
    }
    fn batch_request(sql: &str) -> BatchParameterRequest {
        BatchParameterRequest {
            source: sql.into(),
            sets: vec![request(sql).parameters, request(sql).parameters],
            atomic: true,
            query_id: Some("batch".into()),
            session_id: Some("tab".into()),
            generation: None,
        }
    }

    #[tokio::test]
    async fn batch_commands_keep_values_out_of_history_and_reject_stale_generations() {
        let (directory, app) = app(false).await;
        let selected =
            execute_parameter_batch(app.state(), "c".into(), batch_request("SELECT :delete"))
                .await
                .unwrap();
        assert!(matches!(
            selected.outcome,
            ScriptOutcome::Ok { statements: 2, .. }
        ));
        assert_eq!(selected.progress.sets.len(), 2);
        let failed = execute_parameter_batch(
            app.state(),
            "c".into(),
            batch_request("INSERT INTO saved VALUES(:delete)"),
        )
        .await
        .unwrap();
        assert!(matches!(
            failed.outcome,
            ScriptOutcome::Failed {
                rollback: crate::db::exec::RollbackState::Complete,
                ..
            }
        ));
        assert_eq!(failed.progress.failed_set, Some(1));
        let state = app.state::<AppState>();
        let entries = state.history.list(10);
        assert_eq!(entries.len(), 2);
        let history = std::fs::read_to_string(directory.path().join("history.json")).unwrap();
        assert!(!history.contains("private-bound-value"));
        assert!(history.contains("parameter values are not recorded"));
        let counted = execute_parameter_batch(
            app.state(),
            "c".into(),
            batch_request("SELECT count(*) FROM saved"),
        )
        .await
        .unwrap();
        let ScriptOutcome::Ok { result, .. } = counted.outcome else {
            panic!("count failed")
        };
        assert_eq!(result.rows[0][0], 0);
        let history_count = state.history.list(10).len();
        let mut stale = batch_request("INSERT INTO saved VALUES(:delete)");
        stale.generation = Some(state.sessions.lease("c").unwrap());
        state.sessions.close_connection("c").await;
        state.sessions.mark_connected("c");
        assert!(execute_parameter_batch(app.state(), "c".into(), stale)
            .await
            .is_err());
        assert_eq!(state.history.list(10).len(), history_count);
        assert!(!state.cancel_query("batch"));
    }

    #[tokio::test]
    async fn readonly_batch_commands_allow_bound_names_and_reject_writes() {
        let (_directory, app) = app(true).await;
        let selected =
            execute_parameter_batch(app.state(), "c".into(), batch_request("SELECT :delete"))
                .await
                .unwrap();
        assert!(matches!(
            selected.outcome,
            ScriptOutcome::Ok { statements: 2, .. }
        ));
        let failed = execute_parameter_batch(
            app.state(),
            "c".into(),
            batch_request("SELECT :delete; INSERT INTO saved VALUES(:delete)"),
        )
        .await
        .unwrap();
        assert!(matches!(
            failed.outcome,
            ScriptOutcome::Failed {
                failed_index: 1,
                ..
            }
        ));
        assert_eq!(failed.progress.failed_set, Some(0));
        let state = app.state::<AppState>();
        let pool = state.get_pool("c").unwrap();
        assert_eq!(
            crate::db::exec::execute(&pool, "SELECT count(*) FROM saved")
                .await
                .unwrap()
                .rows[0][0],
            0
        );
        assert!(!state.sessions.status("tab").await.connected);
        assert!(!state.cancel_query("batch"));
    }
    #[tokio::test]
    async fn history_records_templates_and_never_bound_values_even_on_failure() {
        let (directory, app) = app(false).await;
        let analysis = query_parameter_names(
            app.state(),
            "c".into(),
            vec!["INSERT INTO saved VALUES (:delete)".into()],
            Some("tab".into()),
            Some("inspect".into()),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(analysis.names, ["delete"]);
        let mut first = request("INSERT INTO saved VALUES (:delete)");
        first.generation = Some(analysis.generation);
        assert!(matches!(
            execute_parameter_query(app.state(), "c".into(), first)
                .await
                .unwrap(),
            ScriptOutcome::Ok { .. }
        ));
        assert!(matches!(
            execute_parameter_query(
                app.state(),
                "c".into(),
                request("INSERT INTO saved VALUES (:delete)")
            )
            .await
            .unwrap(),
            ScriptOutcome::Failed { .. }
        ));
        let history = std::fs::read_to_string(directory.path().join("history.json")).unwrap();
        assert!(history.contains(":delete"));
        assert!(!history.contains("private-bound-value"));
        assert!(history.contains("parameter values are not recorded"));
        app.state::<AppState>().sessions.close_connection("c").await;
    }
    #[tokio::test]
    async fn readonly_accepts_reserved_parameter_names_but_blocks_writes() {
        let (_directory, app) = app(true).await;
        let selected = execute_parameter_query(app.state(), "c".into(), request("SELECT :delete"))
            .await
            .unwrap();
        assert!(matches!(selected, ScriptOutcome::Ok { .. }));
        let blocked = execute_parameter_query(
            app.state(),
            "c".into(),
            request("INSERT INTO saved VALUES (:delete)"),
        )
        .await
        .unwrap();
        assert!(matches!(blocked, ScriptOutcome::Failed { .. }));
        let pool = app.state::<AppState>().get_pool("c").unwrap();
        let result = crate::db::exec::execute(&pool, "SELECT count(*) FROM saved")
            .await
            .unwrap();
        assert_eq!(result.rows[0][0], 0);
    }
    #[tokio::test]
    async fn generation_change_while_dialog_open_is_rejected() {
        let (_directory, app) = app(false).await;
        let analysis = query_parameter_names(
            app.state(),
            "c".into(),
            vec!["SELECT :delete".into()],
            Some("tab".into()),
            Some("inspect".into()),
            None,
            None,
        )
        .await
        .unwrap();
        let state = app.state::<AppState>();
        state.sessions.close_connection("c").await;
        state.sessions.mark_connected("c");
        let mut query = request("INSERT INTO saved VALUES (:delete)");
        query.generation = Some(analysis.generation);
        assert!(execute_parameter_query(app.state(), "c".into(), query)
            .await
            .is_err());
        assert!(state.history.list(10).is_empty());
    }
    #[tokio::test]
    async fn registered_work_can_be_cancelled_and_duplicate_ids_never_start() {
        let (_directory, app) = app(false).await;
        let state = app.state::<AppState>();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (outcome, ()) = tokio::join!(
            registered(&state, Some("cancel"), async {
                let _ = started.send(());
                std::future::pending::<AppResult<()>>().await
            }),
            async {
                ready.await.unwrap();
                let duplicate = registered(&state, Some("cancel"), async {
                    panic!("duplicate work executed");
                    #[allow(unreachable_code)]
                    Ok(())
                })
                .await;
                assert!(duplicate.is_err());
                assert!(state.cancel_query("cancel"));
            }
        );
        assert!(outcome.is_err());
        assert!(!state.cancel_query("cancel"));
    }

    #[tokio::test]
    async fn source_request_inspection_readonly_and_history_preserve_the_original_template() {
        let (directory, app) = app(true).await;
        let source = "SELECT ';' AS [a;b]; WITH x AS (SELECT :delete) SELECT * FROM x; -- original trailing comment";
        let analysis = query_parameter_names(
            app.state(),
            "c".into(),
            vec![source.into()],
            None,
            None,
            Some(true),
            None,
        )
        .await
        .unwrap();
        assert_eq!(analysis.names, ["delete"]);
        let mut query = request(source);
        query.source_script = true;
        query.generation = Some(analysis.generation);
        assert!(matches!(
            execute_parameter_query(app.state(), "c".into(), query)
                .await
                .unwrap(),
            ScriptOutcome::Ok { statements: 2, .. }
        ));
        let mut query = request("SELECT :delete; INSERT INTO saved VALUES(:delete)");
        query.source_script = true;
        assert!(matches!(
            execute_parameter_query(app.state(), "c".into(), query)
                .await
                .unwrap(),
            ScriptOutcome::Failed {
                failed_index: 1,
                ..
            }
        ));
        let state = app.state::<AppState>();
        let pool = state.get_pool("c").unwrap();
        assert_eq!(
            crate::db::exec::execute(&pool, "SELECT count(*) FROM saved")
                .await
                .unwrap()
                .rows[0][0],
            0
        );
        let entries = state.history.list(10);
        assert!(entries.iter().any(|entry| entry.sql == source));
        let history = std::fs::read_to_string(directory.path().join("history.json")).unwrap();
        assert!(!history.contains("private-bound-value"));
        let mut invalid = request(source);
        invalid.source_script = true;
        invalid.sqls.push("SELECT 2".into());
        assert!(execute_parameter_query(app.state(), "c".into(), invalid)
            .await
            .is_err());
        assert_eq!(state.history.list(10).len(), entries.len());
    }

    #[tokio::test]
    async fn mysql_readonly_rejects_hidden_output_before_all_execution_paths() {
        let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
            return;
        };
        for mode in [
            "",
            "NO_BACKSLASH_ESCAPES",
            "ANSI_QUOTES,NO_BACKSLASH_ESCAPES",
        ] {
            let (_directory, app) = app(true).await;
            let pool = sqlx::mysql::MySqlPoolOptions::new()
                .after_connect(move |conn, _| {
                    Box::pin(async move {
                        sqlx::Executor::execute(
                            conn,
                            format!("SET SESSION sql_mode='{mode}'").as_str(),
                        )
                        .await?;
                        Ok(())
                    })
                })
                .connect(&url)
                .await
                .unwrap();
            let pool = DbPool::Mysql(pool);
            app.state::<AppState>()
                .insert_pool("c".into(), pool.clone());
            for comment in [
                "/*!80000 INTO OUTFILE '/unused' */",
                "/*M! INTO OUTFILE '/unused' */",
            ] {
                for bound in [false, true] {
                    let sql = format!("SELECT {} {comment}", if bound { ":delete" } else { "1" });
                    let mut query = request(&sql);
                    query.source_script = true;
                    if !bound {
                        query.parameters.clear();
                    }
                    match execute_parameter_query(app.state(), "c".into(), query)
                        .await
                        .unwrap()
                    {
                        ScriptOutcome::Failed { error, .. } => assert!(
                            error.contains("without executable comments or INTO"),
                            "{error}"
                        ),
                        _ => panic!("hidden file output reached the server"),
                    }
                }
                let sql = format!("SELECT 1 {comment}");
                for result in [
                    crate::db::exec::execute_readonly(&pool, &sql).await,
                    crate::db::exec::execute_mcp_readonly(&pool, &sql, 100, 4096).await,
                    crate::db::exec::execute_readonly_text_bind(
                        &pool,
                        &format!("SELECT ? {comment}"),
                        "x",
                    )
                    .await,
                ] {
                    assert!(result
                        .unwrap_err()
                        .to_string()
                        .contains("without executable comments or INTO"));
                }
            }
            if mode.contains("NO_BACKSLASH_ESCAPES") {
                let result = crate::db::exec::execute_readonly(
                    &pool,
                    r"SELECT 'x\' /*!80000 INTO OUTFILE '/unused' */ -- '",
                )
                .await;
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("without executable comments or INTO"));
            }
            let mut query =
                request("WITH x AS (SELECT :delete AS value) SELECT * FROM x; SELECT :into");
            query.source_script = true;
            query.parameters.push(QueryParameter {
                name: "into".into(),
                kind: ParameterKind::Text,
                value: Some("safe".into()),
            });
            match execute_parameter_query(app.state(), "c".into(), query)
                .await
                .unwrap()
            {
                ScriptOutcome::Ok { result, .. } => assert_eq!(result.rows[0][0], "safe"),
                ScriptOutcome::Failed { error, .. } => panic!("{error}"),
            }
            let result = crate::db::exec::execute_readonly(&pool, "SELECT '/*! INTO OUTFILE */'")
                .await
                .unwrap();
            assert_eq!(result.rows[0][0], "/*! INTO OUTFILE */");
        }
    }
}
