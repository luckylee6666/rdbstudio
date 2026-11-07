mod common;

use rdbstudio_lib::{
    db::{
        exec::{RollbackState, ScriptOutcome},
        parameters::{ParameterKind, QueryParameter},
        pool::DbPool,
        sessions::{EditorSessions, ParameterExecution},
    },
    error::AppResult,
};
use serde_json::{json, Value};

async fn source(
    sessions: &EditorSessions,
    pool: &DbPool,
    sql: &str,
    parameters: &[QueryParameter],
    atomic: bool,
) -> AppResult<ScriptOutcome> {
    sessions
        .execute_source(
            "c",
            "tab",
            sessions.lease("c")?,
            pool,
            sql,
            ParameterExecution { parameters, atomic },
        )
        .await
}

fn rows(outcome: ScriptOutcome) -> Vec<Vec<Value>> {
    match outcome {
        ScriptOutcome::Ok { result, .. } => result.rows,
        ScriptOutcome::Failed { error, .. } => panic!("{error}"),
    }
}

fn parameter(name: &str, value: &str) -> QueryParameter {
    QueryParameter {
        name: name.into(),
        kind: ParameterKind::Text,
        value: Some(value.into()),
    }
}

#[tokio::test]
async fn source_results_share_a_budget_and_cancellation_discards_uncommitted_state() {
    let pool = common::mem_pool().await;
    let sessions = std::sync::Arc::new(EditorSessions::default());
    let select = "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<6000) SELECT x FROM n;";
    match source(&sessions, &pool, &select.repeat(2), &[], false)
        .await
        .unwrap()
    {
        ScriptOutcome::Ok { results, .. } => {
            assert_eq!(results[0].rows.len(), 6000);
            assert_eq!(results[1].rows.len(), 4000);
            assert!(results[1].truncated);
        }
        ScriptOutcome::Failed { error, .. } => panic!("{error}"),
    }
    source(
        &sessions,
        &pool,
        "CREATE TABLE source_cancel(value INT); BEGIN; INSERT INTO source_cancel VALUES(1)",
        &[],
        false,
    )
    .await
    .unwrap();
    let worker_sessions = sessions.clone();
    let worker_pool = pool.clone();
    let task = tokio::spawn(async move {
        source(&worker_sessions, &worker_pool, "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n; SELECT 2;", &[], true).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(sessions.status("tab").await.needs_reset);
    sessions.close("tab").await;
    let recovered = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        source(
            &sessions,
            &pool,
            "SELECT count(*) FROM source_cancel",
            &[],
            true,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(rows(recovered)[0][0], 0);
    let old_generation = sessions.lease("c").unwrap();
    sessions.close_connection("c").await;
    sessions.mark_connected("c");
    assert!(sessions
        .execute_source(
            "c",
            "tab",
            old_generation,
            &pool,
            "SELECT 1",
            ParameterExecution {
                parameters: &[],
                atomic: true
            }
        )
        .await
        .is_err());
}

#[tokio::test]
async fn sqlite_trigger_is_one_statement_and_parameters_bind_in_later_statements() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    let result = source(&sessions, &pool, "
        CREATE TEMP TABLE saved(value TEXT);
        CREATE TEMP TABLE audit(value TEXT);
        CREATE TEMP TRIGGER log_value AFTER INSERT ON saved BEGIN
            INSERT INTO audit VALUES(CASE WHEN new.value = 'a;END;' THEN 'case;ok' ELSE new.value END);
            INSERT INTO audit VALUES('second');
        END;
        INSERT INTO saved VALUES(:value);
        SELECT value FROM audit ORDER BY rowid;
    ", &[parameter("value", "a;END;")], true).await.unwrap();
    assert!(
        matches!(&result, ScriptOutcome::Ok { statements: 5, results, .. } if results.len() == 5)
    );
    assert_eq!(
        rows(result),
        vec![vec![json!("case;ok")], vec![json!("second")]]
    );
    assert!(!sessions.status("tab").await.in_transaction);
    let result = source(
        &sessions,
        &pool,
        "SELECT 'a\\' AS [a;b]; SELECT ';' AS `c;d`; -- tail",
        &[],
        true,
    )
    .await
    .unwrap();
    assert!(matches!(&result, ScriptOutcome::Ok { statements: 2, .. }));
    assert_eq!(rows(result), vec![vec![json!(";")]]);
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn source_atomic_failure_and_explicit_transactions_have_distinct_rollback_semantics() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    source(
        &sessions,
        &pool,
        "CREATE TEMP TABLE saved(value TEXT UNIQUE)",
        &[],
        true,
    )
    .await
    .unwrap();
    let failed = source(
        &sessions,
        &pool,
        "INSERT INTO saved VALUES('x'); INSERT INTO saved VALUES('x'); SELECT 3",
        &[],
        true,
    )
    .await
    .unwrap();
    assert!(matches!(
        failed,
        ScriptOutcome::Failed {
            failed_index: 1,
            statements: 2,
            rollback: RollbackState::Complete,
            ..
        }
    ));
    assert_eq!(
        rows(
            source(&sessions, &pool, "SELECT count(*) FROM saved", &[], true)
                .await
                .unwrap()
        )[0][0],
        0
    );
    let failed = source(&sessions, &pool, "/* keep transaction */ BEGIN; INSERT INTO saved VALUES('x'); INSERT INTO saved VALUES('x');", &[], true).await.unwrap();
    assert!(matches!(
        failed,
        ScriptOutcome::Failed {
            failed_index: 2,
            rollback: RollbackState::SelfManaged,
            ..
        }
    ));
    assert!(sessions.status("tab").await.in_transaction);
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                "ROLLBACK; SELECT count(*) FROM saved",
                &[],
                true
            )
            .await
            .unwrap()
        )[0][0],
        0
    );
    assert!(!sessions.status("tab").await.in_transaction);
    // An existing user transaction must never be committed by a later automatic script.
    source(&sessions, &pool, "BEGIN", &[], true).await.unwrap();
    source(
        &sessions,
        &pool,
        "INSERT INTO saved VALUES('a'); INSERT INTO saved VALUES('b')",
        &[],
        true,
    )
    .await
    .unwrap();
    assert!(sessions.status("tab").await.in_transaction);
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                "ROLLBACK; SELECT count(*) FROM saved",
                &[],
                true
            )
            .await
            .unwrap()
        )[0][0],
        0
    );
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn source_preflight_rejects_missing_parameters_malformed_sql_and_limits_before_writes() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    source(
        &sessions,
        &pool,
        "CREATE TEMP TABLE saved(value TEXT)",
        &[],
        false,
    )
    .await
    .unwrap();
    for tail in [
        "SELECT :missing".to_owned(),
        "SELECT 'unterminated".to_owned(),
        "SELECT 1;".repeat(128),
    ] {
        let sql = format!("INSERT INTO saved VALUES('must not persist'); {tail}");
        assert!(source(&sessions, &pool, &sql, &[], false).await.is_err());
        assert_eq!(
            rows(
                source(&sessions, &pool, "SELECT count(*) FROM saved", &[], false)
                    .await
                    .unwrap()
            )[0][0],
            0
        );
    }
    assert!(matches!(
        source(&sessions, &pool, "-- no SQL\n /* empty */ ;", &[], true)
            .await
            .unwrap(),
        ScriptOutcome::Ok { statements: 0, .. }
    ));
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn postgres_source_observes_mode_changes_dollar_quotes_and_atomic_routine_bodies() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        return;
    };
    let pool = DbPool::Postgres(sqlx::PgPool::connect(&url).await.unwrap());
    let sessions = EditorSessions::default();
    source(
        &sessions,
        &pool,
        "CREATE TEMP TABLE source_saved(value TEXT)",
        &[],
        false,
    )
    .await
    .unwrap();
    let sql = r"SET standard_conforming_strings=off; SELECT 'a\';b'; SET standard_conforming_strings=on; SELECT 'a\'; SELECT $标签$semi;:not_parameter$标签$;";
    let result = source(&sessions, &pool, sql, &[], true).await.unwrap();
    assert!(matches!(&result, ScriptOutcome::Ok { statements: 5, .. }));
    assert_eq!(rows(result)[0][0], "semi;:not_parameter");
    let sql = "CREATE FUNCTION pg_temp.source_f() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 2 END; SELECT 42; END; /* nested /* ; */ tail */ SELECT pg_temp.source_f();";
    assert_eq!(
        rows(source(&sessions, &pool, sql, &[], true).await.unwrap())[0][0],
        42
    );
    let sql = r"BEGIN; SET LOCAL standard_conforming_strings=off; SELECT 'a\';b'; ROLLBACK; SELECT 'a\'; SELECT :value";
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                sql,
                &[parameter("value", "after rollback")],
                true
            )
            .await
            .unwrap()
        )[0][0],
        "after rollback"
    );
    // The mode change alters statement boundaries and reveals a later parameter.
    let sql = r"INSERT INTO source_saved VALUES('must not persist'); SET standard_conforming_strings=off; SELECT 'a\';x'; SELECT :later";
    assert!(source(&sessions, &pool, sql, &[], false).await.is_err());
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                "SELECT count(*) FROM source_saved",
                &[],
                false
            )
            .await
            .unwrap()
        )[0][0],
        0
    );
    let failed = source(&sessions, &pool, "BEGIN; INSERT INTO source_saved VALUES('rollback me'); SELECT * FROM missing_source_relation;", &[], true).await.unwrap();
    assert!(matches!(
        failed,
        ScriptOutcome::Failed {
            rollback: RollbackState::SelfManaged,
            ..
        }
    ));
    assert!(sessions.status("tab").await.in_transaction);
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                "/* recover */ ROLLBACK; SELECT count(*) FROM source_saved",
                &[],
                true
            )
            .await
            .unwrap()
        )[0][0],
        0
    );
    assert!(!sessions.status("tab").await.in_transaction);
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn mysql_source_delimiter_routines_modes_and_implicit_commit_failure() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        return;
    };
    let pool = DbPool::Mysql(sqlx::MySqlPool::connect(&url).await.unwrap());
    let sessions = EditorSessions::default();
    let routine = format!("source_{}", uuid::Uuid::new_v4().simple());
    let table = format!("source_{}", uuid::Uuid::new_v4().simple());
    let sql = format!("CREATE TABLE `{table}`(value TEXT);\nDELIMITER $$\nCREATE PROCEDURE `{routine}`() BEGIN INSERT INTO `{table}` VALUES('a;$$'); INSERT INTO `{table}` VALUES('second'); END$$\nDELIMITER ;\nCALL `{routine}`(); SELECT count(*) FROM `{table}`;");
    assert_eq!(
        rows(source(&sessions, &pool, &sql, &[], true).await.unwrap())[0][0],
        2
    );
    let sql =
        r#"SET sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'; SELECT 'a\'; SELECT "value" FROM "#;
    let sql = format!("{sql}`{table}` LIMIT 1; # comment\n SELECT 3--2;");
    assert_eq!(
        rows(source(&sessions, &pool, &sql, &[], true).await.unwrap())[0][0],
        5
    );
    let sql = format!("INSERT INTO `{table}` VALUES('committed'); ALTER TABLE `{table}` ADD COLUMN n INT; SELECT * FROM definitely_missing_source_table;");
    assert!(matches!(
        source(&sessions, &pool, &sql, &[], true).await.unwrap(),
        ScriptOutcome::Failed {
            rollback: RollbackState::Partial,
            ..
        }
    ));
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                &format!("SELECT count(*) FROM `{table}`"),
                &[],
                false
            )
            .await
            .unwrap()
        )[0][0],
        3
    );
    source(
        &sessions,
        &pool,
        &format!("DROP PROCEDURE `{routine}`; DROP TABLE `{table}`;"),
        &[],
        false,
    )
    .await
    .unwrap();
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn mysql_conditional_comments_bind_only_active_parameters_and_track_transactions() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        return;
    };
    let pool = DbPool::Mysql(sqlx::MySqlPool::connect(&url).await.unwrap());
    let sessions = EditorSessions::default();
    source(
        &sessions,
        &pool,
        "CREATE TEMPORARY TABLE conditional_saved(value TEXT)",
        &[],
        false,
    )
    .await
    .unwrap();
    let sql = "/*! BEGIN */; INSERT INTO conditional_saved VALUES(:value); /*! COMMIT */; INSERT INTO conditional_saved VALUES('also committed'); SELECT * FROM missing_conditional_table";
    assert!(matches!(
        source(
            &sessions,
            &pool,
            sql,
            &[parameter("value", "committed")],
            true
        )
        .await
        .unwrap(),
        ScriptOutcome::Failed {
            rollback: RollbackState::SelfManaged,
            ..
        }
    ));
    assert!(!sessions.status("tab").await.in_transaction);
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                "SELECT count(*) FROM conditional_saved",
                &[],
                false
            )
            .await
            .unwrap()
        )[0][0],
        2
    );
    let sql =
        "SELECT /*!40101 :value, */ 'ordinary' /*!999999 , :inactive */ /*M! , :maria_only */";
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                sql,
                &[parameter("value", "bound inside comment")],
                false
            )
            .await
            .unwrap()
        )[0],
        vec![json!("bound inside comment"), json!("ordinary")]
    );
    let sql =
        "INSERT INTO conditional_saved VALUES('must not persist'); SELECT /*!40101 :missing, */ 1";
    assert!(source(&sessions, &pool, sql, &[], false).await.is_err());
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                "SELECT count(*) FROM conditional_saved",
                &[],
                false
            )
            .await
            .unwrap()
        )[0][0],
        2
    );
    source(
        &sessions,
        &pool,
        "/*!999999 SET @not_executed=1 */; SELECT 1;",
        &[],
        true,
    )
    .await
    .unwrap();
    source(
        &sessions,
        &pool,
        "SET autocommit=0; INSERT INTO conditional_saved VALUES('uncommitted');",
        &[],
        true,
    )
    .await
    .unwrap();
    assert!(sessions.status("tab").await.in_transaction);
    source(&sessions, &pool, "ROLLBACK; SET autocommit=1", &[], true)
        .await
        .unwrap();
    assert!(!sessions.status("tab").await.in_transaction);
    assert_eq!(
        rows(
            source(
                &sessions,
                &pool,
                "SELECT count(*) FROM conditional_saved",
                &[],
                false
            )
            .await
            .unwrap()
        )[0][0],
        2
    );
    sessions.close_connection("c").await;
}
