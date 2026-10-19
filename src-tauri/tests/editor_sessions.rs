mod common;

use rdbstudio_lib::db::{exec::ScriptOutcome, sessions::EditorSessions};

async fn run(
    sessions: &EditorSessions,
    pool: &rdbstudio_lib::db::pool::DbPool,
    tab: &str,
    sql: &str,
) -> serde_json::Value {
    let generation = sessions.lease("connection").unwrap();
    match sessions
        .execute(
            "connection",
            tab,
            generation,
            pool,
            &[sql.to_owned()],
            false,
        )
        .await
        .unwrap()
    {
        ScriptOutcome::Ok { result, .. } => result
            .rows
            .first()
            .and_then(|r| r.first())
            .cloned()
            .unwrap_or_default(),
        ScriptOutcome::Failed { error, .. } => panic!("{error}"),
    }
}

#[tokio::test]
async fn session_keeps_transaction_between_runs_and_isolates_temp_tables() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    sessions.mark_connected("connection");
    run(&sessions, &pool, "a", "CREATE TABLE saved(id INTEGER)").await;
    run(&sessions, &pool, "a", "BEGIN").await;
    run(&sessions, &pool, "a", "INSERT INTO saved VALUES (1)").await;
    assert!(sessions.status("a").await.in_transaction);
    run(&sessions, &pool, "a", "ROLLBACK").await;
    assert_eq!(
        run(&sessions, &pool, "a", "SELECT count(*) FROM saved").await,
        0
    );
    run(
        &sessions,
        &pool,
        "a",
        "CREATE TEMP TABLE private(value TEXT)",
    )
    .await;
    run(
        &sessions,
        &pool,
        "a",
        "INSERT INTO private VALUES ('retained')",
    )
    .await;
    assert_eq!(
        run(&sessions, &pool, "a", "SELECT value FROM private").await,
        "retained"
    );
    let generation = sessions.lease("connection").unwrap();
    let other = sessions
        .execute(
            "connection",
            "b",
            generation,
            &pool,
            &["SELECT * FROM private".into()],
            false,
        )
        .await
        .unwrap();
    assert!(matches!(other, ScriptOutcome::Failed { .. }));
    sessions.close("a").await;
    sessions.close("b").await;
    // Closing tabs must not destroy the shared in-memory database.
    assert_eq!(
        run(&sessions, &pool, "c", "SELECT count(*) FROM saved").await,
        0
    );
    sessions.close_connection("connection").await;
}

#[tokio::test]
async fn script_returns_every_result_and_reset_rolls_back() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    sessions.mark_connected("connection");
    let generation = sessions.lease("connection").unwrap();
    let outcome = sessions
        .execute(
            "connection",
            "a",
            generation,
            &pool,
            &["SELECT 1 AS first".into(), "SELECT 2 AS second".into()],
            true,
        )
        .await
        .unwrap();
    match outcome {
        ScriptOutcome::Ok { results, .. } => {
            assert_eq!(results.len(), 2);
            assert_eq!(results[0].rows[0][0], 1);
            assert_eq!(results[1].rows[0][0], 2);
        }
        _ => panic!("script failed"),
    }
    run(&sessions, &pool, "a", "CREATE TABLE saved(id INTEGER)").await;
    run(&sessions, &pool, "a", "BEGIN").await;
    run(&sessions, &pool, "a", "INSERT INTO saved VALUES(1)").await;
    sessions.close("a").await;
    assert_eq!(
        run(&sessions, &pool, "b", "SELECT count(*) FROM saved").await,
        0
    );
    sessions.close_connection("connection").await;
}

#[tokio::test]
async fn disconnect_generation_rejects_a_request_holding_a_stale_pool_clone() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(3)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let db = rdbstudio_lib::db::pool::DbPool::Sqlite(pool.clone());
    let sessions = EditorSessions::default();
    let old_generation = sessions.mark_connected("connection");
    let first = sessions
        .execute(
            "connection",
            "query-tab",
            old_generation,
            &db,
            &["SELECT 1".into()],
            false,
        )
        .await
        .unwrap();
    assert!(matches!(first, ScriptOutcome::Ok { .. }));

    // This represents a query that cloned the old pool just before Disconnect
    // but reaches the session registry after a reconnect installed a new pool.
    sessions.close_connection("connection").await;
    assert!(!sessions.status("query-tab").await.connected);
    let _new_generation = sessions.mark_connected("connection");
    let stale = sessions
        .execute(
            "connection",
            "query-tab",
            old_generation,
            &db,
            &["SELECT 2".into()],
            false,
        )
        .await;
    assert!(
        stale.is_err(),
        "an old query must not reopen a session after reconnect"
    );

    let current_generation = sessions.lease("connection").unwrap();
    let fresh = sessions
        .execute(
            "connection",
            "query-tab",
            current_generation,
            &db,
            &["SELECT 3".into()],
            false,
        )
        .await
        .unwrap();
    assert!(matches!(fresh, ScriptOutcome::Ok { .. }));
    sessions.close_connection("connection").await;
    pool.close().await;
}

#[tokio::test]
async fn rollback_to_savepoint_with_comments_or_newlines_keeps_transaction_open() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    sessions.mark_connected("connection");
    run(
        &sessions,
        &pool,
        "tab",
        "CREATE TABLE savepoint_rows (value INTEGER)",
    )
    .await;
    run(&sessions, &pool, "tab", "BEGIN").await;
    run(&sessions, &pool, "tab", "SAVEPOINT keep_row").await;
    run(
        &sessions,
        &pool,
        "tab",
        "INSERT INTO savepoint_rows VALUES (1)",
    )
    .await;
    run(
        &sessions,
        &pool,
        "tab",
        "ROLLBACK /* comment */\nTO SAVEPOINT keep_row",
    )
    .await;
    assert!(sessions.status("tab").await.in_transaction);
    run(&sessions, &pool, "tab", "ROLLBACK").await;
    assert!(!sessions.status("tab").await.in_transaction);
    assert_eq!(
        run(
            &sessions,
            &pool,
            "tab",
            "SELECT count(*) FROM savepoint_rows"
        )
        .await,
        0
    );
    sessions.close_connection("connection").await;
}

#[tokio::test]
async fn sqlite_cancel_interrupts_the_worker_and_does_not_reuse_a_dirty_session() {
    use std::sync::Arc;
    let pool = common::mem_pool().await;
    let sessions = Arc::new(EditorSessions::default());
    run(&sessions, &pool, "a", "CREATE TABLE saved(id INTEGER)").await;
    run(&sessions, &pool, "a", "BEGIN").await;
    run(&sessions, &pool, "a", "INSERT INTO saved VALUES(1)").await;
    let worker_sessions = sessions.clone();
    let worker_pool = pool.clone();
    let generation = sessions.lease("connection").unwrap();
    let task = tokio::spawn(async move {
        worker_sessions.execute("connection","a",generation,&worker_pool,&["WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n".into()],false).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(sessions.status("a").await.needs_reset);
    assert!(sessions
        .execute(
            "connection",
            "a",
            generation,
            &pool,
            &["SELECT 1".into()],
            false
        )
        .await
        .is_err());
    sessions.close("a").await;
    let count = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        run(&sessions, &pool, "b", "SELECT count(*) FROM saved"),
    )
    .await
    .unwrap();
    assert_eq!(count, 0);
    sessions.close_connection("connection").await;
}

#[tokio::test]
async fn releasing_the_outer_sqlite_savepoint_restores_atomic_script_execution() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    run(&sessions, &pool, "a", "CREATE TABLE saved(id INTEGER)").await;
    run(&sessions, &pool, "a", "SAVEPOINT first").await;
    assert!(sessions.status("a").await.in_transaction);
    run(&sessions, &pool, "a", "RELEASE first").await;
    assert!(!sessions.status("a").await.in_transaction);
    let generation = sessions.lease("connection").unwrap();
    let outcome = sessions
        .execute(
            "connection",
            "a",
            generation,
            &pool,
            &[
                "INSERT INTO saved VALUES(1)".into(),
                "SELECT missing FROM saved".into(),
            ],
            true,
        )
        .await
        .unwrap();
    assert!(matches!(outcome, ScriptOutcome::Failed { .. }));
    assert_eq!(
        run(&sessions, &pool, "a", "SELECT count(*) FROM saved").await,
        0
    );
    sessions.close_connection("connection").await;
}
