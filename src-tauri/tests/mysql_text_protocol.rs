//! MySQL editor SQL must reach the server over the text protocol.
//!
//! MySQL rejects `PREPARE` / `EXECUTE` / `DEALLOCATE PREPARE` (and friends)
//! with error 1295 when they are themselves sent as prepared statements, which
//! is what `sqlx::query` does. Hand-written migration scripts use exactly that
//! idiom for conditional DDL, so the editor paths send raw SQL instead.
//!
//! Needs a live server; set `RDBSTUDIO_TEST_MYSQL_URL` to run it:
//!
//! ```text
//! RDBSTUDIO_TEST_MYSQL_URL=mysql://root@127.0.0.1:3306/mysql \
//!     cargo test --test mysql_text_protocol
//! ```
//!
//! Every statement here is read-only — the test never touches schema or data.

use rdbstudio_lib::db::exec::{self, ScriptOutcome};
use rdbstudio_lib::db::pool::DbPool;

async fn mysql_pool() -> Option<DbPool> {
    let url = std::env::var("RDBSTUDIO_TEST_MYSQL_URL").ok()?;
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to RDBSTUDIO_TEST_MYSQL_URL");
    Some(DbPool::Mysql(pool))
}

#[tokio::test]
async fn script_runs_prepare_execute_deallocate() {
    let Some(pool) = mysql_pool().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_URL is not set");
        return;
    };

    let stmts: Vec<String> = [
        "SET @stmt_sql := 'SELECT 1 AS one'",
        "PREPARE rdbstudio_probe FROM @stmt_sql",
        "EXECUTE rdbstudio_probe",
        "DEALLOCATE PREPARE rdbstudio_probe",
        "SELECT @stmt_sql AS carried_over",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    match exec::execute_script(&pool, &stmts, true)
        .await
        .expect("script")
    {
        ScriptOutcome::Ok { result, .. } => {
            // User variables are session state: the whole script must have run
            // on one connection for the last SELECT to see the first SET.
            assert_eq!(
                result.rows[0][0].as_str(),
                Some("SELECT 1 AS one"),
                "user variable did not survive the script"
            );
        }
        ScriptOutcome::Failed { error, .. } => panic!("script failed: {error}"),
    }
}

#[tokio::test]
async fn single_statement_runs_unprepared_command() {
    let Some(pool) = mysql_pool().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_URL is not set");
        return;
    };

    exec::execute(&pool, "PREPARE rdbstudio_probe_single FROM 'SELECT 1'")
        .await
        .expect("PREPARE over the text protocol");
    exec::execute(&pool, "DEALLOCATE PREPARE rdbstudio_probe_single")
        .await
        .expect("DEALLOCATE over the text protocol");

    let r = exec::execute(&pool, "SHOW VARIABLES LIKE 'version'")
        .await
        .expect("SHOW over the text protocol");
    assert_eq!(r.rows.len(), 1, "expected one row from SHOW VARIABLES");
}

/// The MCP bridge puts MySQL itself in read-only mode before running a query.
/// That guard used to be sent as a prepared statement, which MySQL rejects
/// with 1295 — every MySQL query through the bridge failed on it.
#[tokio::test]
async fn mcp_read_only_guard_lets_a_query_through() {
    let Some(pool) = mysql_pool().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_URL is not set");
        return;
    };

    let r = exec::execute_mcp_readonly(&pool, "SELECT 1 AS one", 10, 10_000)
        .await
        .expect("MCP read-only query runs");
    assert_eq!(r.rows.len(), 1);
    assert_eq!(r.columns[0].name, "one");
}
