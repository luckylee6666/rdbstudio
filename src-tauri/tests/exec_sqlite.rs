mod common;

use rdbstudio_lib::db::exec;

#[tokio::test]
async fn execute_select_returns_columns_and_rows() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    // Selecting id/name from a real typed table guarantees sqlite_val
    // decodes the columns via their declared storage classes.
    let r = exec::execute(&pool, "SELECT id, name FROM users ORDER BY id")
        .await
        .expect("execute select");
    assert!(!r.columns.is_empty(), "expected columns for SELECT");
    assert_eq!(r.rows.len(), 3, "expected 3 rows for seeded users");
    // First row's id should be 1
    let first = &r.rows[0][0];
    assert_eq!(first.as_i64(), Some(1), "expected id=1, got {:?}", first);
    let first_name = &r.rows[0][1];
    assert_eq!(first_name.as_str(), Some("Alice"));
}

#[tokio::test]
async fn execute_update_reports_rows_affected() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let r = exec::execute(&pool, "UPDATE users SET age = 99 WHERE id = 1")
        .await
        .expect("execute update");
    assert_eq!(r.rows_affected, Some(1), "expected 1 row updated");
    assert!(r.rows.is_empty());
    assert!(r.columns.is_empty());
}

#[tokio::test]
async fn execute_select_returns_all_rows() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let r = exec::execute(&pool, "SELECT id, name FROM users ORDER BY id")
        .await
        .expect("execute select all");
    assert_eq!(r.rows.len(), 3);
    assert_eq!(r.columns.len(), 2);
    assert!(!r.truncated, "small result must not be flagged truncated");
}

#[tokio::test]
async fn execute_insert_returning_yields_rows() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let r = exec::execute(
        &pool,
        "INSERT INTO users (name, age) VALUES ('Dave', 40) RETURNING id, name",
    )
    .await
    .expect("insert returning");
    assert_eq!(r.rows.len(), 1, "RETURNING must surface the row");
    assert_eq!(r.columns.len(), 2);
    assert_eq!(r.rows[0][1].as_str(), Some("Dave"));
}

#[tokio::test]
async fn execute_select_caps_huge_results_and_flags_truncation() {
    let pool = common::mem_pool().await;

    // Recursive CTE generates MAX_ROWS + 1 rows without inserting anything.
    let over = exec::MAX_ROWS + 1;
    let sql = format!(
        "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < {over}) \
         SELECT x FROM cnt"
    );
    let r = exec::execute(&pool, &sql).await.expect("capped select");
    assert_eq!(r.rows.len(), exec::MAX_ROWS, "rows must stop at the cap");
    assert!(r.truncated, "over-cap result must be flagged truncated");

    // Exactly at the cap: full result, no false-positive truncation flag.
    let at = exec::MAX_ROWS;
    let sql = format!(
        "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < {at}) \
         SELECT x FROM cnt"
    );
    let r = exec::execute(&pool, &sql).await.expect("at-cap select");
    assert_eq!(r.rows.len(), exec::MAX_ROWS);
    assert!(!r.truncated, "exactly-at-cap must not be flagged truncated");
}

#[tokio::test]
async fn execute_script_commits_all_statements() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let stmts = vec![
        "UPDATE users SET age = 10 WHERE id = 1".to_string(),
        "UPDATE users SET age = 20 WHERE id = 2".to_string(),
        "SELECT count(*) AS n FROM users WHERE age IN (10, 20)".to_string(),
    ];
    let out = exec::execute_script(&pool, &stmts).await.expect("script");
    match out {
        exec::ScriptOutcome::Ok {
            result,
            total_affected,
            statements,
        } => {
            assert_eq!(statements, 3);
            assert_eq!(total_affected, 2, "two UPDATEs of one row each");
            assert_eq!(
                result.rows[0][0].as_i64(),
                Some(2),
                "last statement's rows are the displayed result"
            );
        }
        other => panic!("expected Ok, got {:?}", other),
    }
}

#[tokio::test]
async fn execute_script_rolls_back_earlier_statements_on_failure() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let stmts = vec![
        "UPDATE users SET age = 111 WHERE id = 1".to_string(),
        "INSERT INTO no_such_table VALUES (1)".to_string(),
    ];
    let out = exec::execute_script(&pool, &stmts)
        .await
        .expect("failed scripts still return an outcome, not Err");
    match out {
        exec::ScriptOutcome::Failed {
            failed_index,
            statements,
            error,
        } => {
            assert_eq!(failed_index, 1);
            assert_eq!(statements, 2);
            assert!(!error.is_empty());
        }
        other => panic!("expected Failed, got {:?}", other),
    }
    let r = exec::execute(&pool, "SELECT age FROM users WHERE id = 1")
        .await
        .expect("check");
    assert_ne!(
        r.rows[0][0].as_i64(),
        Some(111),
        "statement before the failure must be rolled back"
    );
}
