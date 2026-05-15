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
}
