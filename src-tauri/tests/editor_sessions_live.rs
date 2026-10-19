use rdbstudio_lib::db::{exec::ScriptOutcome, pool::DbPool, sessions::EditorSessions};
async fn run(sessions: &EditorSessions, pool: &DbPool, sql: &str) -> serde_json::Value {
    let generation = sessions.lease("c").unwrap();
    match sessions
        .execute("c", "a", generation, pool, &[sql.into()], false)
        .await
        .unwrap()
    {
        ScriptOutcome::Ok { result, .. } => result
            .rows
            .first()
            .and_then(|row| row.first())
            .cloned()
            .unwrap_or_default(),
        ScriptOutcome::Failed { error, .. } => panic!("{error}"),
    }
}
#[tokio::test]
async fn mysql_variables_manual_commit_and_temporary_tables_survive_separate_runs() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        return;
    };
    let pool = DbPool::Mysql(sqlx::MySqlPool::connect(&url).await.unwrap());
    let sessions = EditorSessions::default();
    run(&sessions, &pool, "SET @rdbstudio_value=123").await;
    assert_eq!(run(&sessions, &pool, "SELECT @rdbstudio_value").await, 123);
    run(&sessions, &pool, "CREATE TEMPORARY TABLE saved(id INTEGER)").await;
    run(&sessions, &pool, "SET SESSION autocommit=0").await;
    run(&sessions, &pool, "INSERT INTO saved VALUES(1)").await;
    let generation = sessions.lease("c").unwrap();
    let outcome = sessions
        .execute(
            "c",
            "a",
            generation,
            &pool,
            &[
                "INSERT INTO saved VALUES(2)".into(),
                "SELECT count(*) FROM saved".into(),
            ],
            true,
        )
        .await
        .unwrap();
    assert!(matches!(outcome, ScriptOutcome::Ok { .. }));
    run(&sessions, &pool, "ROLLBACK").await;
    assert_eq!(run(&sessions, &pool, "SELECT count(*) FROM saved").await, 0);
    run(&sessions, &pool, "SET SESSION autocommit=1").await;
    run(&sessions, &pool, "BEGIN").await;
    run(&sessions, &pool, "INSERT INTO saved VALUES(3)").await;
    run(&sessions, &pool, "CREATE TEMPORARY TABLE auxiliary(id INT)").await;
    assert!(sessions.status("a").await.in_transaction);
    run(&sessions, &pool, "ROLLBACK").await;
    assert_eq!(run(&sessions, &pool, "SELECT count(*) FROM saved").await, 0);
    sessions.close_connection("c").await;
}
#[tokio::test]
async fn postgres_tab_keeps_temp_tables_and_rolls_back_between_runs() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        return;
    };
    let pool = DbPool::Postgres(sqlx::PgPool::connect(&url).await.unwrap());
    let sessions = EditorSessions::default();
    run(&sessions, &pool, "CREATE TEMP TABLE saved(id INTEGER)").await;
    run(&sessions, &pool, "BEGIN").await;
    run(&sessions, &pool, "INSERT INTO saved VALUES(1)").await;
    assert_eq!(run(&sessions, &pool, "SELECT count(*) FROM saved").await, 1);
    run(&sessions, &pool, "ROLLBACK").await;
    assert_eq!(run(&sessions, &pool, "SELECT count(*) FROM saved").await, 0);
    let generation = sessions.lease("c").unwrap();
    assert!(matches!(
        sessions
            .execute(
                "c",
                "b",
                generation,
                &pool,
                &["SELECT * FROM saved".into()],
                false
            )
            .await
            .unwrap(),
        ScriptOutcome::Failed { .. }
    ));
    sessions.close_connection("c").await;
}
