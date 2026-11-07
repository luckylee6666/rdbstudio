mod common;
use rdbstudio_lib::db::{
    exec::{RollbackState, ScriptOutcome},
    parameters::{ParameterKind, QueryParameter},
    pool::DbPool,
    sessions::{EditorSessions, ParameterBatchExecution},
};

fn set(value: &str) -> Vec<QueryParameter> {
    vec![QueryParameter {
        name: "value".into(),
        kind: ParameterKind::Text,
        value: Some(value.into()),
    }]
}
async fn run(s: &EditorSessions, p: &DbPool, sql: &str) -> ScriptOutcome {
    s.execute_source(
        "c",
        "tab",
        s.lease("c").unwrap(),
        p,
        sql,
        rdbstudio_lib::db::sessions::ParameterExecution {
            parameters: &[],
            atomic: false,
        },
    )
    .await
    .unwrap()
}
fn count(outcome: ScriptOutcome) -> i64 {
    match outcome {
        ScriptOutcome::Ok { result, .. } => result.rows[0][0].as_i64().unwrap(),
        ScriptOutcome::Failed { error, .. } => panic!("{error}"),
    }
}

#[tokio::test]
async fn atomic_batch_preserves_set_boundaries_and_rolls_back_prior_sets_on_failure() {
    let p = common::mem_pool().await;
    let s = EditorSessions::default();
    run(&s, &p, "CREATE TABLE saved(value TEXT UNIQUE)").await;
    let sets = vec![set("first"), set("second")];
    let result = s
        .execute_batch(
            "c",
            "tab",
            s.lease("c").unwrap(),
            &p,
            "INSERT INTO saved VALUES(:value); SELECT :value",
            ParameterBatchExecution {
                sets: &sets,
                atomic: true,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        result.outcome,
        ScriptOutcome::Ok {
            statements: 4,
            total_affected: 2,
            ..
        }
    ));
    assert_eq!(result.progress.sets.len(), 2);
    assert_eq!(result.progress.sets[1].first_result, 2);
    assert_eq!(result.progress.sets[1].result_count, 2);
    assert!(!s.status("tab").await.in_transaction);
    let result = s
        .execute_batch(
            "c",
            "tab",
            s.lease("c").unwrap(),
            &p,
            "INSERT INTO saved VALUES(:value)",
            ParameterBatchExecution {
                sets: &[set("new"), set("first"), set("not reached")],
                atomic: true,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        result.outcome,
        ScriptOutcome::Failed {
            failed_index: 0,
            rollback: RollbackState::Complete,
            ..
        }
    ));
    assert_eq!(result.progress.failed_set, Some(1));
    assert_eq!(result.progress.sets.len(), 1);
    assert_eq!(count(run(&s, &p, "SELECT count(*) FROM saved").await), 2);
    s.close_connection("c").await;
}

#[tokio::test]
async fn validates_all_sets_before_any_write_and_keeps_user_transactions_in_control() {
    let p = common::mem_pool().await;
    let s = EditorSessions::default();
    run(&s, &p, "CREATE TABLE saved(value TEXT UNIQUE)").await;
    assert!(s
        .execute_batch(
            "c",
            "tab",
            s.lease("c").unwrap(),
            &p,
            "INSERT INTO saved VALUES(:value)",
            ParameterBatchExecution {
                sets: &[set("must not persist"), vec![]],
                atomic: false
            }
        )
        .await
        .is_err());
    assert_eq!(count(run(&s, &p, "SELECT count(*) FROM saved").await), 0);
    run(&s, &p, "BEGIN").await;
    let result = s
        .execute_batch(
            "c",
            "tab",
            s.lease("c").unwrap(),
            &p,
            "INSERT INTO saved VALUES(:value)",
            ParameterBatchExecution {
                sets: &[set("first"), set("first")],
                atomic: true,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        result.outcome,
        ScriptOutcome::Failed {
            rollback: RollbackState::SelfManaged,
            ..
        }
    ));
    assert!(s.status("tab").await.in_transaction);
    assert_eq!(
        count(run(&s, &p, "ROLLBACK; SELECT count(*) FROM saved").await),
        0
    );
    // A script's own transaction must not be wrapped by the batch runner.
    let result = s
        .execute_batch(
            "c",
            "tab",
            s.lease("c").unwrap(),
            &p,
            "BEGIN; INSERT INTO saved VALUES(:value); ROLLBACK",
            ParameterBatchExecution {
                sets: &[set("first"), set("second")],
                atomic: true,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        result.outcome,
        ScriptOutcome::Ok { statements: 6, .. }
    ));
    assert_eq!(count(run(&s, &p, "SELECT count(*) FROM saved").await), 0);
    s.close_connection("c").await;
}

#[tokio::test]
async fn batch_results_share_one_row_budget_across_sets() {
    let p = common::mem_pool().await;
    let s = EditorSessions::default();
    let result = s.execute_batch("c", "tab", s.lease("c").unwrap(), &p,
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<6000) SELECT :value, x FROM n", ParameterBatchExecution { sets: &[set("first"), set("second")], atomic: true }).await.unwrap();
    let ScriptOutcome::Ok { results, .. } = result.outcome else {
        panic!("batch failed")
    };
    assert_eq!(results[0].rows.len(), 6000);
    assert_eq!(results[1].rows.len(), 4000);
    assert!(results[1].truncated);
    s.close_connection("c").await;
}

#[tokio::test]
async fn non_atomic_failure_keeps_previously_committed_changes() {
    let p = common::mem_pool().await;
    let s = EditorSessions::default();
    run(&s, &p, "CREATE TABLE saved(value TEXT UNIQUE)").await;
    let failed = s
        .execute_batch(
            "c",
            "tab",
            s.lease("c").unwrap(),
            &p,
            "INSERT INTO saved VALUES(:value)",
            ParameterBatchExecution {
                sets: &[set("committed"), set("committed")],
                atomic: false,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        failed.outcome,
        ScriptOutcome::Failed {
            rollback: RollbackState::SelfManaged,
            ..
        }
    ));
    assert_eq!(failed.progress.failed_set, Some(1));
    assert!(!s.status("tab").await.in_transaction);
    assert_eq!(count(run(&s, &p, "SELECT count(*) FROM saved").await), 1);
    s.close_connection("c").await;
}

#[tokio::test]
async fn postgres_batch_holds_the_session_lock_across_parameter_sets() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: batch session lock test requires RDBSTUDIO_TEST_PG_URL");
        return;
    };
    let pg = sqlx::PgPool::connect(&url).await.unwrap();
    let p = DbPool::Postgres(pg.clone());
    let s = std::sync::Arc::new(EditorSessions::default());
    assert!(matches!(
        run(&s, &p, "CREATE TEMPORARY TABLE saved(value TEXT)").await,
        ScriptOutcome::Ok { .. }
    ));
    let pid = count(run(&s, &p, "SELECT pg_backend_pid()").await);
    let worker_sessions = s.clone();
    let worker_pool = p.clone();
    let task = tokio::spawn(async move {
        worker_sessions
            .execute_batch(
                "c",
                "tab",
                worker_sessions.lease("c").unwrap(),
                &worker_pool,
                "INSERT INTO saved VALUES(:value); SELECT pg_sleep(0.15)",
                ParameterBatchExecution {
                    sets: &[set("one"), set("two")],
                    atomic: true,
                },
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let sleeping: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep')")
                .bind(pid as i32).fetch_one(&pg).await.unwrap();
            if sleeping { break; }
            assert!(!task.is_finished(), "batch finished before reaching the slow statement");
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    // A competing operation on the same tab must observe both completed sets.
    assert_eq!(count(run(&s, &p, "SELECT count(*) FROM saved").await), 2);
    assert!(matches!(
        task.await.unwrap().unwrap().outcome,
        ScriptOutcome::Ok { statements: 4, .. }
    ));
    s.close_connection("c").await;
}

#[tokio::test]
async fn cancelling_a_batch_discards_its_connection_and_rolls_back_owned_writes() {
    let p = common::mem_pool().await;
    let s = std::sync::Arc::new(EditorSessions::default());
    run(&s, &p, "CREATE TABLE saved(value TEXT)").await;
    let worker_sessions = s.clone();
    let worker_pool = p.clone();
    let task = tokio::spawn(async move {
        worker_sessions.execute_batch("c", "tab", worker_sessions.lease("c").unwrap(), &worker_pool,
            "INSERT INTO saved VALUES(:value); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",
            ParameterBatchExecution { sets: &[set("cancelled"), set("not reached")], atomic: true }).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!task.is_finished());
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert!(s.status("tab").await.needs_reset);
    s.close("tab").await;
    let recovered = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        run(&s, &p, "SELECT count(*) FROM saved"),
    )
    .await
    .unwrap();
    assert_eq!(count(recovered), 0);
    s.close_connection("c").await;
}

#[tokio::test]
async fn postgres_and_mysql_batches_bind_values_and_roll_back_all_sets() {
    let mut pools = vec![];
    if let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") {
        pools.push(DbPool::Postgres(sqlx::PgPool::connect(&url).await.unwrap()));
    }
    if let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") {
        pools.push(DbPool::Mysql(sqlx::MySqlPool::connect(&url).await.unwrap()));
    }
    for p in pools {
        let s = EditorSessions::default();
        assert!(matches!(
            run(
                &s,
                &p,
                "CREATE TEMPORARY TABLE batch_saved(value VARCHAR(255) UNIQUE)"
            )
            .await,
            ScriptOutcome::Ok { .. }
        ));
        let values = [set("quote'; SELECT :hidden; -- \\"), set("第二组")];
        let result = s
            .execute_batch(
                "c",
                "tab",
                s.lease("c").unwrap(),
                &p,
                "INSERT INTO batch_saved VALUES(:value); SELECT :value",
                ParameterBatchExecution {
                    sets: &values,
                    atomic: true,
                },
            )
            .await
            .unwrap();
        let ScriptOutcome::Ok { results, .. } = result.outcome else {
            panic!("roundtrip failed")
        };
        assert_eq!(
            results[1].rows[0][0],
            values[0][0].value.as_deref().unwrap()
        );
        assert_eq!(results[3].rows[0][0], "第二组");
        assert_eq!(result.progress.sets[1].first_result, 2);
        let failed = s
            .execute_batch(
                "c",
                "tab",
                s.lease("c").unwrap(),
                &p,
                "INSERT INTO batch_saved VALUES(:value)",
                ParameterBatchExecution {
                    sets: &[set("rollback"), set("第二组")],
                    atomic: true,
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            failed.outcome,
            ScriptOutcome::Failed {
                rollback: RollbackState::Complete,
                ..
            }
        ));
        assert_eq!(failed.progress.failed_set, Some(1));
        assert_eq!(
            count(run(&s, &p, "SELECT count(*) FROM batch_saved").await),
            2
        );
        s.close_connection("c").await;
    }
}

#[tokio::test]
async fn mysql_future_set_modes_are_checked_before_writes_and_ddl_reports_partial_rollback() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        return;
    };
    let p = DbPool::Mysql(sqlx::MySqlPool::connect(&url).await.unwrap());
    let s = EditorSessions::default();
    let table = format!("batch_{}", uuid::Uuid::new_v4().simple());
    assert!(matches!(
        run(
            &s,
            &p,
            &format!("CREATE TABLE `{table}`(value VARCHAR(255) UNIQUE); SET sql_mode='' ")
        )
        .await,
        ScriptOutcome::Ok { .. }
    ));
    let source = format!("SELECT 'a\\'; SELECT :later; -- '\n; INSERT INTO `{table}` VALUES(:value); SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'");
    let mut first = set("must not persist");
    first.push(QueryParameter {
        name: "later".into(),
        kind: ParameterKind::Text,
        value: Some("future".into()),
    });
    let error = match s
        .execute_batch(
            "c",
            "tab",
            s.lease("c").unwrap(),
            &p,
            &source,
            ParameterBatchExecution {
                sets: &[first, set("second")],
                atomic: false,
            },
        )
        .await
    {
        Err(error) => error.to_string(),
        Ok(_) => panic!("future parameter should be missing"),
    };
    assert!(error.contains("parameter set 2"), "{error}");
    assert!(error.contains("later"), "{error}");
    assert_eq!(
        count(run(&s, &p, &format!("SELECT count(*) FROM `{table}`")).await),
        0
    );
    let source =
        format!("INSERT INTO `{table}` VALUES(:value); ALTER TABLE `{table}` ADD COLUMN added INT");
    let failed = s
        .execute_batch(
            "c",
            "tab",
            s.lease("c").unwrap(),
            &p,
            &source,
            ParameterBatchExecution {
                sets: &[set("first"), set("second")],
                atomic: true,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        failed.outcome,
        ScriptOutcome::Failed {
            rollback: RollbackState::Partial,
            ..
        }
    ));
    assert_eq!(failed.progress.failed_set, Some(1));
    // The first set's DDL committed its insert. The rejected second DDL may
    // fail during preparation, before its implicit commit, depending on server.
    let persisted = count(run(&s, &p, &format!("SELECT count(*) FROM `{table}`")).await);
    assert!((1..=2).contains(&persisted));
    run(&s, &p, &format!("DROP TABLE `{table}`")).await;
    s.close_connection("c").await;
}
