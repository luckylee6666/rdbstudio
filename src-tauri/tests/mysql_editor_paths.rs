//! MySQL editor paths that need a live server and a scratch database:
//! what a failed script leaves behind, whether a self-managed transaction
//! really shares one connection, and whether a read-only connection is
//! enforced by the server rather than by statement classification alone.
//!
//! MySQL commits the open transaction before it runs DDL, so `ROLLBACK` after
//! a mid-script failure cannot undo an `ALTER TABLE` — not even one hidden
//! behind `PREPARE stmt FROM @ddl; EXECUTE stmt`. `ScriptOutcome::Failed`
//! reports that through `rollback_complete` so the editor stops promising a
//! rollback it did not get; this test pins the flag to what the server
//! actually kept.
//!
//! Needs a scratch server: the test creates and drops the database
//! `rdbstudio_rollback_test`.
//!
//! ```text
//! RDBSTUDIO_TEST_MYSQL_SCRATCH_URL=mysql://root@127.0.0.1:3306/mysql \
//!     cargo test --test mysql_editor_paths
//! ```

use rdbstudio_lib::db::data::{self, Filter, FilterOp, TableQuery};
use rdbstudio_lib::db::exec::{self, RollbackState, ScriptOutcome};
use rdbstudio_lib::db::pool::DbPool;
use serde_json::json;
use sqlx::Row;

const SCRATCH_DB: &str = "rdbstudio_rollback_test";
const TXN_SCRATCH_DB: &str = "rdbstudio_selfmanaged_test";
const RO_SCRATCH_DB: &str = "rdbstudio_readonly_test";

fn stmts(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

async fn count(pool: &sqlx::MySqlPool, sql: &str) -> i64 {
    sqlx::raw_sql(sql)
        .fetch_one(pool)
        .await
        .unwrap()
        .get::<i64, _>(0)
}

#[tokio::test]
async fn failed_script_reports_whether_the_rollback_was_total() {
    let Ok(base) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is not set");
        return;
    };
    let admin = sqlx::MySqlPool::connect(&base).await.expect("connect");
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("drop stale scratch database");
    sqlx::raw_sql(&format!("CREATE DATABASE {SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("create scratch database");

    let url = base
        .rsplit_once('/')
        .map(|(host, _)| format!("{host}/{SCRATCH_DB}"))
        .expect("connection URL carries a database");
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to scratch database");
    sqlx::raw_sql("CREATE TABLE t (id INT PRIMARY KEY)")
        .execute(&pool)
        .await
        .expect("seed table");

    // Conditional DDL followed by a failing statement — the shape a migration
    // script takes when it guards an ALTER on information_schema.
    let ddl_script = stmts(&[
        "SET @ddl := 'ALTER TABLE `t` ADD COLUMN `pushed` TINYINT NOT NULL DEFAULT 0'",
        "PREPARE add_col FROM @ddl",
        "EXECUTE add_col",
        "DEALLOCATE PREPARE add_col",
        "INSERT INTO no_such_table VALUES (1)",
    ]);
    let ddl_outcome = exec::execute_script(&DbPool::Mysql(pool.clone()), &ddl_script, true)
        .await
        .expect("failed scripts return an outcome, not Err");
    let column_survived = count(
        &pool,
        "SELECT COUNT(*) FROM information_schema.columns \
         WHERE table_schema = DATABASE() AND table_name = 't' AND column_name = 'pushed'",
    )
    .await;

    // Pure DML on the same server must still report a clean rollback.
    let dml_script = stmts(&[
        "INSERT INTO t VALUES (1)",
        "INSERT INTO no_such_table VALUES (1)",
    ]);
    let dml_outcome = exec::execute_script(&DbPool::Mysql(pool.clone()), &dml_script, true)
        .await
        .expect("failed scripts return an outcome, not Err");
    let rows_left = count(&pool, "SELECT COUNT(*) FROM t").await;

    pool.close().await;
    sqlx::raw_sql(&format!("DROP DATABASE {SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("drop scratch database");

    match ddl_outcome {
        ScriptOutcome::Failed {
            failed_index,
            rollback,
            ..
        } => {
            assert_eq!(failed_index, 4);
            assert_eq!(column_survived, 1, "MySQL keeps DDL across a rollback");
            assert!(
                matches!(rollback, RollbackState::Partial),
                "the added column outlived the rollback, so the report must say so"
            );
        }
        other => panic!("expected a failure, got {other:?}"),
    }

    match dml_outcome {
        ScriptOutcome::Failed { rollback, .. } => {
            assert_eq!(rows_left, 0, "the INSERT must be rolled back");
            assert!(
                matches!(rollback, RollbackState::Complete),
                "pure DML rolls back completely"
            );
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}

/// A script with its own `BEGIN` / `ROLLBACK` must run on one connection.
/// Statement by statement over a 5-connection pool, the `INSERT` used to land
/// on a different connection than the `BEGIN` — autocommitted, and the user's
/// `ROLLBACK` then undid nothing.
#[tokio::test]
async fn self_managed_transaction_runs_on_one_connection() {
    let Ok(base) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is not set");
        return;
    };
    let admin = sqlx::MySqlPool::connect(&base).await.expect("connect");
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {TXN_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("drop stale scratch database");
    sqlx::raw_sql(&format!("CREATE DATABASE {TXN_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("create scratch database");

    let url = base
        .rsplit_once('/')
        .map(|(host, _)| format!("{host}/{TXN_SCRATCH_DB}"))
        .expect("connection URL carries a database");
    // The pool size the app builds its connections with.
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect to scratch database");
    sqlx::raw_sql("CREATE TABLE t (id INT PRIMARY KEY)")
        .execute(&pool)
        .await
        .expect("seed table");

    // Two idle connections, as any real session has: the tree, autocomplete
    // and table views share the editor's pool.
    let a = pool.acquire().await.expect("first connection");
    let b = pool.acquire().await.expect("second connection");
    drop(a);
    drop(b);

    let script = stmts(&["BEGIN", "INSERT INTO t VALUES (1)", "ROLLBACK"]);
    let outcome = exec::execute_script(&DbPool::Mysql(pool.clone()), &script, false)
        .await
        .expect("script runs");
    let rows_left = count(&pool, "SELECT COUNT(*) FROM t").await;

    pool.close().await;
    sqlx::raw_sql(&format!("DROP DATABASE {TXN_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("drop scratch database");

    assert!(
        matches!(outcome, ScriptOutcome::Ok { .. }),
        "expected the script to run, got {outcome:?}"
    );
    assert_eq!(
        rows_left, 0,
        "the script's own ROLLBACK must undo its INSERT"
    );
}

/// A read-only connection must be stopped by the server, not just by the
/// statement classifier — `execute_readonly` runs inside
/// `START TRANSACTION READ ONLY`.
#[tokio::test]
async fn read_only_connections_are_enforced_by_the_server() {
    let Ok(base) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is not set");
        return;
    };
    let admin = sqlx::MySqlPool::connect(&base).await.expect("connect");
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {RO_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("drop stale scratch database");
    sqlx::raw_sql(&format!("CREATE DATABASE {RO_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("create scratch database");
    let url = base
        .rsplit_once('/')
        .map(|(host, _)| format!("{host}/{RO_SCRATCH_DB}"))
        .expect("connection URL carries a database");
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect to scratch database");
    sqlx::raw_sql("CREATE TABLE t (id INT PRIMARY KEY)")
        .execute(&pool)
        .await
        .expect("seed table");

    let db = DbPool::Mysql(pool.clone());
    let refused = exec::execute_readonly(&db, "INSERT INTO t VALUES (1)").await;
    let read_back = exec::execute_readonly(&db, "SELECT COUNT(*) AS n FROM t").await;
    let rows_after = count(&pool, "SELECT COUNT(*) FROM t").await;

    pool.close().await;
    sqlx::raw_sql(&format!("DROP DATABASE {RO_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("drop scratch database");

    let err = refused
        .expect_err("the server must refuse the write")
        .to_string();
    assert!(
        err.to_lowercase().contains("read only") || err.contains("1792"),
        "expected a read-only transaction error, got {err}"
    );
    assert_eq!(rows_after, 0, "nothing may have been written");
    // Reads still work on the same pool afterwards.
    assert!(read_back.expect("read after refused write").rows.len() == 1);
}

const TYPES_SCRATCH_DB: &str = "rdbstudio_types_test";

/// Temporal and DECIMAL columns used to render as NULL (the decoder tried
/// `NaiveDateTime` for DATE/TIME/TIMESTAMP and `String` for DECIMAL), and a
/// `contains` filter died with error 1064 because `ESCAPE '\'` is an
/// unterminated MySQL string literal.
#[tokio::test]
async fn temporal_and_decimal_columns_decode_and_like_filters_run() {
    let Ok(base) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is not set");
        return;
    };
    let admin = sqlx::MySqlPool::connect(&base).await.expect("connect");
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {TYPES_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("drop stale scratch database");
    sqlx::raw_sql(&format!("CREATE DATABASE {TYPES_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("create scratch database");

    let url = base
        .rsplit_once('/')
        .map(|(host, _)| format!("{host}/{TYPES_SCRATCH_DB}"))
        .expect("connection URL carries a database");
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to scratch database");
    sqlx::raw_sql(
        "CREATE TABLE t (id INT PRIMARY KEY AUTO_INCREMENT, d DATE, tm TIME, \
         dt DATETIME, ts TIMESTAMP NULL, n DECIMAL(10,2), name VARCHAR(50))",
    )
    .execute(&pool)
    .await
    .expect("create table");
    sqlx::raw_sql(
        "INSERT INTO t (d,tm,dt,ts,n,name) VALUES \
         ('2024-01-01','13:45:30','2024-01-01 13:45:30','2024-01-01 13:45:30',1234.56,'widget')",
    )
    .execute(&pool)
    .await
    .expect("seed row");
    let db = DbPool::Mysql(pool.clone());

    let r = exec::execute(&db, "SELECT * FROM t").await.expect("select");
    let row = &r.rows[0];
    assert_eq!(row[1], json!("2024-01-01"), "DATE: {:?}", r.rows);
    assert_eq!(row[2], json!("13:45:30"), "TIME: {:?}", r.rows);
    assert_eq!(row[3], json!("2024-01-01 13:45:30"), "DATETIME: {:?}", r.rows);
    assert_eq!(row[4], json!("2024-01-01 13:45:30"), "TIMESTAMP: {:?}", r.rows);
    assert_eq!(row[5], json!("1234.56"), "DECIMAL: {:?}", r.rows);

    // The grid path decodes through the same helpers.
    let q = TableQuery {
        schema: None,
        table: "t".into(),
        limit: 50,
        offset: 0,
        order_by: None,
        filters: vec![],
        where_raw: None,
    };
    let grid = data::fetch(&db, &q).await.expect("fetch");
    assert_eq!(grid.rows[0][1], json!("2024-01-01"));

    let contains = TableQuery {
        filters: vec![Filter {
            column: "name".into(),
            op: FilterOp::Contains,
            value: Some("wid".into()),
        }],
        ..q
    };
    let filtered = data::fetch(&db, &contains)
        .await
        .expect("contains filter must not be a syntax error");
    assert_eq!(filtered.rows.len(), 1);

    drop(db);
    pool.close().await;
    sqlx::raw_sql(&format!("DROP DATABASE {TYPES_SCRATCH_DB}"))
        .execute(&admin)
        .await
        .expect("drop scratch database");
}
