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
async fn mcp_execution_enforces_sqlite_read_only_at_the_database_layer() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let selected = exec::execute_mcp_readonly(
        &pool,
        "SELECT id, name FROM users ORDER BY id",
        100,
        64 * 1024,
    )
    .await
    .expect("MCP read");
    assert_eq!(selected.rows.len(), 3);

    let write = exec::execute_mcp_readonly(
        &pool,
        "UPDATE users SET name = 'changed' WHERE id = 1",
        100,
        64 * 1024,
    )
    .await;
    assert!(
        write.is_err(),
        "query_only must reject writes independently of SQL parsing"
    );

    // The failed MCP command must restore the shared session before returning.
    let unchanged = exec::execute(&pool, "SELECT name FROM users WHERE id = 1")
        .await
        .expect("verify unchanged row");
    assert_eq!(unchanged.rows[0][0].as_str(), Some("Alice"));

    exec::execute(&pool, "UPDATE users SET age = 31 WHERE id = 1")
        .await
        .expect("editor connection remains writable after MCP cleanup");
}

#[tokio::test]
async fn mcp_execution_streams_under_row_and_byte_budgets() {
    let pool = common::mem_pool().await;

    let by_rows = exec::execute_mcp_readonly(
        &pool,
        "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10) SELECT x FROM cnt",
        3,
        64 * 1024,
    )
    .await
    .expect("row-limited MCP query");
    assert_eq!(by_rows.rows.len(), 3);
    assert!(by_rows.truncated);

    let by_bytes = exec::execute_mcp_readonly(
        &pool,
        "SELECT 'this value is deliberately larger than the tiny budget' AS value",
        10,
        8,
    )
    .await
    .expect("byte-limited MCP query");
    assert!(by_bytes.rows.is_empty());
    assert!(by_bytes.truncated);
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
    let out = exec::execute_script(&pool, &stmts, true)
        .await
        .expect("script");
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
    let out = exec::execute_script(&pool, &stmts, true)
        .await
        .expect("failed scripts still return an outcome, not Err");
    match out {
        exec::ScriptOutcome::Failed {
            failed_index,
            statements,
            error,
            rollback,
        } => {
            assert_eq!(failed_index, 1);
            assert_eq!(statements, 2);
            assert!(!error.is_empty());
            // SQLite rolls DDL back like anything else.
            assert!(matches!(rollback, exec::RollbackState::Complete));
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

#[tokio::test]
async fn empty_result_set_still_carries_its_columns() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    // No rows to build the header from — the grid would otherwise be blank.
    let r = exec::execute(&pool, "SELECT id, name FROM users WHERE 1 = 0")
        .await
        .expect("execute select");
    assert!(r.rows.is_empty());
    let names: Vec<&str> = r.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["id", "name"]);
}

#[tokio::test]
async fn empty_result_set_in_a_script_keeps_its_columns() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let stmts = vec![
        "SELECT 1".to_string(),
        "SELECT id, name FROM users WHERE 1 = 0".to_string(),
    ];
    match exec::execute_script(&pool, &stmts, true)
        .await
        .expect("script")
    {
        exec::ScriptOutcome::Ok { result, .. } => {
            let names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
            assert_eq!(names, vec!["id", "name"]);
        }
        other => panic!("expected Ok, got {other:?}"),
    }
}

#[tokio::test]
async fn read_only_connections_are_enforced_by_the_database() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    // Statement classification is the first layer; this is the one that holds
    // when the classification is wrong (a SELECT calling a writing function).
    let err = exec::execute_readonly(&pool, "UPDATE users SET age = 1 WHERE id = 1")
        .await
        .expect_err("SQLite itself must refuse the write");
    assert!(
        err.to_string().to_lowercase().contains("readonly"),
        "expected a read-only error, got {err}"
    );

    // The guard is lifted again, so the connection stays usable for reads.
    let r = exec::execute_readonly(&pool, "SELECT age FROM users WHERE id = 1")
        .await
        .expect("read after a refused write");
    assert_eq!(
        r.rows[0][0].as_i64(),
        Some(30),
        "the UPDATE must not have run"
    );
}

#[tokio::test]
async fn read_only_scripts_run_without_a_wrapping_transaction() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let stmts = vec![
        "SELECT count(*) AS n FROM users".to_string(),
        "SELECT name FROM users ORDER BY id".to_string(),
    ];
    match exec::execute_script_readonly(&pool, &stmts)
        .await
        .expect("read-only script")
    {
        exec::ScriptOutcome::Ok {
            result, statements, ..
        } => {
            assert_eq!(statements, 2);
            assert_eq!(result.rows[0][0].as_str(), Some("Alice"));
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    let failing = vec![
        "SELECT 1".to_string(),
        "UPDATE users SET age = 1".to_string(),
    ];
    match exec::execute_script_readonly(&pool, &failing)
        .await
        .expect("read-only script")
    {
        exec::ScriptOutcome::Failed { failed_index, .. } => assert_eq!(failed_index, 1),
        other => panic!("expected Failed, got {other:?}"),
    }
}
