//! MySQL copies never transport table rows through the application.
//!
//! A separate read transaction keeps the source's metadata lock across CREATE
//! LIKE (which implicitly commits its own connection) and INSERT SELECT. The
//! latter uses READ COMMITTED, so its SELECT is one consistent, nonlocking read.
//! See MySQL's `metadata-locking`, `create-table-like`, and
//! `innodb-consistent-read` reference-manual sections.

use super::{
    cancelled, fingerprint, CopyPhase, CopyPlan, CopyReport, NativeCopyRequest, ProgressFn,
};
use crate::db::meta::mysql_show_str;
use crate::error::{AppError, AppResult};
use sqlx::{Connection, Executor, MySqlConnection, MySqlPool, Row};
use tokio_util::sync::CancellationToken;

struct Source {
    schema: String,
    definition: String,
    columns: Vec<String>,
    auto_increment: Option<u64>,
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", ident(schema), ident(table))
}

fn validate_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name.contains('\0') || name.chars().count() > 64 {
        return Err(AppError::msg(
            "MySQL table/schema names must contain 1–64 characters and no NUL",
        ));
    }
    Ok(())
}

fn check_cancel(cancel: &CancellationToken) -> AppResult<()> {
    if cancel.is_cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}

/// Remove only unquoted AUTO_INCREMENT=n table options. The counter changes on
/// ordinary INSERTs; it is data state, not a structural preview invalidation.
/// Quoted identifiers, string defaults, and comments are left byte-for-byte.
fn stable_definition(sql: &str) -> (String, Option<u64>) {
    let bytes = sql.as_bytes();
    let mut output = String::with_capacity(sql.len());
    let mut cursor = 0;
    let mut copy_from = 0;
    let mut counter = None;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\'' | b'"' | b'`' => {
                let quote = bytes[cursor];
                cursor += 1;
                while cursor < bytes.len() {
                    if bytes[cursor] == b'\\' && quote != b'`' {
                        cursor = (cursor + 2).min(bytes.len());
                    } else if bytes[cursor] == quote {
                        cursor += 1;
                        if cursor < bytes.len() && bytes[cursor] == quote {
                            cursor += 1;
                        } else {
                            break;
                        }
                    } else {
                        cursor += 1;
                    }
                }
            }
            b'/' if bytes.get(cursor + 1) == Some(&b'*') => {
                cursor += 2;
                while cursor + 1 < bytes.len() && &bytes[cursor..cursor + 2] != b"*/" {
                    cursor += 1;
                }
                cursor = (cursor + 2).min(bytes.len());
            }
            _ if bytes[cursor..].starts_with(b"AUTO_INCREMENT=") => {
                let start = cursor + "AUTO_INCREMENT=".len();
                let mut end = start;
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    end += 1;
                }
                if end > start {
                    // SHOW CREATE can omit AUTO_INCREMENT entirely while an
                    // auto-increment table is empty. Remove the whole option,
                    // including its separator, so the first INSERT is harmless.
                    let option_start = if cursor > copy_from && bytes[cursor - 1] == b' ' {
                        cursor - 1
                    } else {
                        cursor
                    };
                    output.push_str(&sql[copy_from..option_start]);
                    counter = sql[start..end].parse().ok();
                    copy_from = end;
                }
                cursor = end.max(cursor + 1);
            }
            _ => cursor += 1,
        }
    }
    output.push_str(&sql[copy_from..]);
    (output, counter)
}

async fn schema(
    connection: &mut MySqlConnection,
    request: &NativeCopyRequest,
) -> AppResult<String> {
    validate_name(&request.source_table)?;
    validate_name(&request.target_table)?;
    let schema = match request.schema.as_deref().filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_owned(),
        None => sqlx::query_scalar::<_, Option<String>>(
            "SELECT CAST(DATABASE() AS CHAR CHARACTER SET utf8mb4)",
        )
        .fetch_one(&mut *connection)
        .await?
        .ok_or_else(|| AppError::msg("Select a MySQL database before copying a table"))?,
    };
    validate_name(&schema)?;
    Ok(schema)
}

async fn target_absent(
    connection: &mut MySqlConnection,
    schema: &str,
    table: &str,
) -> AppResult<()> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    )
    .bind(schema)
    .bind(table)
    .fetch_one(connection)
    .await?;
    if count != 0 {
        return Err(AppError::msg(
            "The destination table already exists; it will not be overwritten",
        ));
    }
    Ok(())
}

async fn definition(connection: &mut MySqlConnection, table: &str) -> AppResult<String> {
    let row = connection
        .fetch_one(format!("SHOW CREATE TABLE {table}").as_str())
        .await?;
    mysql_show_str(&row, "Create Table", 1)
        .ok_or_else(|| AppError::msg("MySQL did not return a readable CREATE TABLE definition"))
}

/// Must be called with the source metadata lock already held.
async fn source(
    connection: &mut MySqlConnection,
    schema: String,
    table: &str,
) -> AppResult<Source> {
    let row = sqlx::query(
        "SELECT CAST(TABLE_TYPE AS CHAR CHARACTER SET utf8mb4) AS TABLE_TYPE, \
         CAST(ENGINE AS CHAR CHARACTER SET utf8mb4) AS ENGINE FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    )
    .bind(&schema)
    .bind(table)
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| AppError::msg("The source table no longer exists"))?;
    let kind: String = row.try_get("TABLE_TYPE")?;
    let engine: Option<String> = row.try_get("ENGINE")?;
    if kind != "BASE TABLE" || !engine.is_some_and(|value| value.eq_ignore_ascii_case("InnoDB")) {
        return Err(AppError::msg(
            "Native MySQL table copy supports ordinary InnoDB tables only",
        ));
    }
    let definition = definition(connection, &qualified(&schema, table)).await?;
    let (_, auto_increment) = stable_definition(&definition);
    let rows = sqlx::query(
        "SELECT CAST(COLUMN_NAME AS CHAR CHARACTER SET utf8mb4) AS COLUMN_NAME, \
         CAST(GENERATION_EXPRESSION AS CHAR CHARACTER SET utf8mb4) AS GENERATION_EXPRESSION FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    )
    .bind(&schema)
    .bind(table)
    .fetch_all(connection)
    .await?;
    let mut columns = Vec::with_capacity(rows.len());
    for row in rows {
        let generated: Option<String> = row.try_get("GENERATION_EXPRESSION")?;
        // DEFAULT_GENERATED describes a default expression, not a generated
        // column. Explicitly enumerate invisible columns as well.
        if generated.as_deref().is_none_or(str::is_empty) {
            columns.push(row.try_get::<String, _>("COLUMN_NAME")?);
        }
    }
    if columns.is_empty() {
        return Err(AppError::msg("The source has no writable columns to copy"));
    }
    Ok(Source {
        schema,
        definition,
        columns,
        auto_increment,
    })
}

fn source_fingerprint(source: &Source, request: &NativeCopyRequest) -> String {
    fingerprint(&format!(
        "mysql\0{}\0{}\0{}\0{}",
        source.schema,
        request.source_table,
        request.target_table,
        stable_definition(&source.definition).0,
    ))
}

fn insert_sql(source: &Source, request: &NativeCopyRequest, stage: &str) -> String {
    let columns = source
        .columns
        .iter()
        .map(|column| ident(column))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "INSERT INTO {} ({columns}) SELECT {columns} FROM {}",
        qualified(&source.schema, stage),
        qualified(&source.schema, &request.source_table),
    )
}

async fn lock_source(connection: &mut MySqlConnection, schema: &str, table: &str) -> AppResult<()> {
    connection
        .execute("SET SESSION lock_wait_timeout = 60")
        .await?;
    connection.execute("START TRANSACTION").await?;
    // Opening a table in a transaction takes a transaction-duration metadata
    // lock even when LIMIT 0 makes the data scan empty.
    connection
        .execute(format!("SELECT 1 FROM {} LIMIT 0", qualified(schema, table)).as_str())
        .await?;
    Ok(())
}

pub async fn preview(pool: &MySqlPool, request: &NativeCopyRequest) -> AppResult<CopyPlan> {
    let options = pool.connect_options();
    let mut connection = MySqlConnection::connect_with(&options).await?;
    let result = async {
        let schema = schema(&mut connection, request).await?;
        lock_source(&mut connection, &schema, &request.source_table).await?;
        target_absent(&mut connection, &schema, &request.target_table).await?;
        let source = source(&mut connection, schema, &request.source_table).await?;
        let stage = "__rdb_copy_<random>";
        let mut statements = vec![
            "-- Separate source connection: START TRANSACTION; SELECT 1 FROM source LIMIT 0 (metadata lock)".into(),
            "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED".into(),
            "SET SESSION sql_mode = CONCAT_WS(',', @@sql_mode, 'STRICT_ALL_TABLES', 'NO_AUTO_VALUE_ON_ZERO')".into(),
            format!("CREATE TABLE {} LIKE {}", qualified(&source.schema, stage), qualified(&source.schema, &request.source_table)),
            insert_sql(&source, request, stage),
        ];
        if let Some(counter) = source.auto_increment {
            statements.push(format!("ALTER TABLE {} AUTO_INCREMENT = {counter}", qualified(&source.schema, stage)));
        }
        statements.push(format!("RENAME TABLE {} TO {}", qualified(&source.schema, stage), qualified(&source.schema, &request.target_table)));
        Ok(CopyPlan {
            fingerprint: source_fingerprint(&source, request),
            statements,
            warnings: vec![
                "MySQL CREATE TABLE LIKE does not copy foreign keys, triggers, table-specific grants, DATA DIRECTORY or INDEX DIRECTORY options. Generated columns are recalculated.".into(),
                "Rows are copied from one execution-time InnoDB snapshot. Source schema changes wait for the copy's metadata lock; ordinary source writes may continue.".into(),
                "MySQL DDL cannot be rolled back. A uniquely named staging table is removed on failure/cancellation before publication; cleanup requires LOCK TABLES and DROP privileges, and failures report its name. The final atomic rename is the publication point and never overwrites an existing table.".into(),
            ],
            transactional: false,
        })
    }.await;
    // Dedicated connections prevent transaction and session settings leaking
    // into editor sessions or a pool configured with only one connection.
    let _ = connection.execute("ROLLBACK").await;
    let _ = connection.close().await;
    result
}

async fn no_warnings(connection: &mut MySqlConnection) -> AppResult<()> {
    // SHOW COUNT(*) WARNINGS is not supported by MySQL's prepared protocol.
    // Execute directly so checking diagnostics cannot introduce error 1295.
    let row = connection.fetch_one("SHOW COUNT(*) WARNINGS").await?;
    let warnings: u64 = row.try_get(0)?;
    if warnings > 0 {
        return Err(AppError::msg(format!("MySQL reported {warnings} warning(s); the copy will not be published to avoid silent data conversion")));
    }
    Ok(())
}

/// Kill only the two fresh connections owned by this operation. Await the
/// original operation afterward: KILL QUERY is a request, not proof of rollback.
async fn interrupt(pool: &MySqlPool, worker_id: u64, guard_id: u64) -> AppResult<()> {
    let options = pool.connect_options();
    let mut controller = MySqlConnection::connect_with(&options).await?;
    let first = controller
        .execute(format!("KILL QUERY {worker_id}").as_str())
        .await;
    let second = controller
        .execute(format!("KILL QUERY {guard_id}").as_str())
        .await;
    let _ = controller.close().await;
    first?;
    second?;
    Ok(())
}

/// The random name and successful CREATE establish ownership. Before cleanup,
/// lock and compare the definition captured immediately after that CREATE. If
/// another client changed/replaced it, leave it for inspection instead of
/// blindly deleting an unrelated object. Never fall back to deleting target.
async fn cleanup(
    worker: &mut MySqlConnection,
    stage: &str,
    expected_definition: Option<&str>,
) -> AppResult<()> {
    let expected = expected_definition.ok_or_else(|| {
        AppError::msg(format!(
        "Staging table {stage} may remain: its ownership could not be verified; no DROP was issued"
    ))
    })?;
    worker.execute("ROLLBACK").await?;
    worker
        .execute(format!("LOCK TABLES {stage} WRITE").as_str())
        .await?;
    let current = definition(worker, stage).await?;
    if stable_definition(&current).0 != expected {
        return Err(AppError::msg(format!(
            "Staging table {stage} changed after creation; refusing to drop it"
        )));
    }
    worker
        .execute(format!("DROP TABLE {stage}").as_str())
        .await?;
    worker.execute("UNLOCK TABLES").await?;
    Ok(())
}

pub async fn execute(
    pool: &MySqlPool,
    request: &NativeCopyRequest,
    expected: &str,
    cancel: CancellationToken,
    progress: ProgressFn,
) -> AppResult<CopyReport> {
    check_cancel(&cancel)?;
    progress(CopyPhase::Preparing);
    let options = pool.connect_options();
    let mut worker = tokio::select! {
        result = MySqlConnection::connect_with(&options) => result?,
        _ = cancel.cancelled() => return Err(cancelled()),
    };
    let mut guard = tokio::select! {
        result = MySqlConnection::connect_with(&options) => result?,
        _ = cancel.cancelled() => return Err(cancelled()),
    };
    let worker_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(&mut worker)
        .await?;
    let guard_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(&mut guard)
        .await?;
    let stage_name = format!("__rdb_copy_{}", uuid::Uuid::new_v4().simple());
    let mut stage = String::new();
    let mut created = false;
    let mut create_failed = false;
    let mut stage_definition = None;
    let mut published = false;
    let mut interruption_error = None;
    let result = {
        let operation = async {
            let schema = schema(&mut guard, request).await?;
            check_cancel(&cancel)?;
            lock_source(&mut guard, &schema, &request.source_table).await?;
            check_cancel(&cancel)?;
            target_absent(&mut guard, &schema, &request.target_table).await?;
            let source = source(&mut guard, schema, &request.source_table).await?;
            if source_fingerprint(&source, request) != expected {
                return Err(AppError::msg("The source table structure changed after preview; preview again before copying"));
            }
            stage = qualified(&source.schema, &stage_name);
            worker.execute("SET SESSION lock_wait_timeout = 60").await?;
            worker
                .execute("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")
                .await?;
            worker.execute("SET SESSION sql_mode = CONCAT_WS(',', @@sql_mode, 'STRICT_ALL_TABLES', 'NO_AUTO_VALUE_ON_ZERO')").await?;
            check_cancel(&cancel)?;
            progress(CopyPhase::Creating);
            check_cancel(&cancel)?;
            worker
                .execute(
                    format!(
                        "CREATE TABLE {stage} LIKE {}",
                        qualified(&source.schema, &request.source_table)
                    )
                    .as_str(),
                )
                .await
                .map_err(|error| {
                    // CREATE may have committed before its reply was lost.
                    // Unacknowledged creation does not establish ownership.
                    create_failed = true;
                    AppError::msg(format!(
                        "Creating staging table {stage} failed; inspect this exact table for possible residue because the server-side outcome is unconfirmed. No automatic DROP was issued: {error}"
                    ))
                })?;
            created = true;
            // Capture ownership before consulting the cancellation token.
            // A CREATE that finished just as cancellation arrived still needs
            // cleanup, even though the copying phase has not begun.
            let create_warnings = no_warnings(&mut worker).await;
            stage_definition = Some(stable_definition(&definition(&mut worker, &stage).await?).0);
            create_warnings?;
            check_cancel(&cancel)?;
            progress(CopyPhase::Copying);
            check_cancel(&cancel)?;
            let rows_copied = worker
                .execute(insert_sql(&source, request, &stage_name).as_str())
                .await?
                .rows_affected();
            no_warnings(&mut worker).await?;
            check_cancel(&cancel)?;
            if let Some(counter) = source.auto_increment {
                worker
                    .execute(format!("ALTER TABLE {stage} AUTO_INCREMENT = {counter}").as_str())
                    .await?;
                no_warnings(&mut worker).await?;
            }
            check_cancel(&cancel)?;
            progress(CopyPhase::Finishing);
            check_cancel(&cancel)?;
            // The last cancellation boundary is immediately before publication.
            // If RENAME succeeds, success wins a concurrent cancel request.
            worker
                .execute(
                    format!(
                        "RENAME TABLE {stage} TO {}",
                        qualified(&source.schema, &request.target_table)
                    )
                    .as_str(),
                )
                .await?;
            published = true;
            Ok(CopyReport { rows_copied })
        };
        tokio::pin!(operation);
        tokio::select! {
            biased;
            result = &mut operation => result,
            _ = cancel.cancelled() => {
                progress(CopyPhase::Cancelling);
                if let Err(error) = interrupt(pool, worker_id, guard_id).await {
                    interruption_error = Some(error);
                }
                operation.await
            }
        }
    };
    // Release source MDL before cleanup. Awaiting the operation above ensures
    // no worker statement is still running when DROP is sent.
    let _ = guard.execute("ROLLBACK").await;
    let _ = guard.close().await;
    let cleanup_result = if created && !published {
        cleanup(&mut worker, &stage, stage_definition.as_deref()).await
    } else {
        Ok(())
    };
    let _ = worker.close().await;
    if let Err(error) = cleanup_result {
        let original = result
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "Copy stopped".into());
        return Err(AppError::msg(format!(
            "{original}; cleanup failed; staging table {stage} may remain: {error}"
        )));
    }
    if published {
        return result;
    }
    // Keep the concrete residue warning even when cancellation also occurred.
    if create_failed {
        return result;
    }
    if cancel.is_cancelled() {
        if let Some(error) = interruption_error {
            return Err(AppError::msg(format!("Copy cancelled after waiting for the active statement and cleaning up; KILL QUERY failed: {error}")));
        }
        return Err(cancelled());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_copy_fingerprint_ignores_counter_but_not_quoted_content() {
        let sql = "CREATE TABLE `AUTO_INCREMENT=1` (`id` bigint AUTO_INCREMENT, `v` text DEFAULT 'AUTO_INCREMENT=7') ENGINE=InnoDB AUTO_INCREMENT=900 COMMENT='AUTO_INCREMENT=8'";
        let (stable, counter) = stable_definition(sql);
        assert_eq!(counter, Some(900));
        assert!(stable.contains("`AUTO_INCREMENT=1`"));
        assert!(stable.contains("DEFAULT 'AUTO_INCREMENT=7'"));
        assert!(stable.contains("COMMENT='AUTO_INCREMENT=8'"));
        assert!(!stable.contains("AUTO_INCREMENT=900"));
        assert_eq!(
            stable_definition(&sql.replace(" AUTO_INCREMENT=900", "")).0,
            stable
        );
        assert_eq!(
            stable_definition(&sql.replace("AUTO_INCREMENT=900", "AUTO_INCREMENT=999")).0,
            stable
        );
    }

    #[test]
    fn mysql_copy_quotes_all_explicit_columns_and_qualified_names() {
        let request = NativeCopyRequest {
            schema: Some("a`b".into()),
            source_table: "source`table".into(),
            target_table: "target".into(),
        };
        let source = Source {
            schema: "a`b".into(),
            definition: String::new(),
            columns: vec!["invisible`column".into(), "default_expression".into()],
            auto_increment: None,
        };
        assert_eq!(insert_sql(&source, &request, "stage"), "INSERT INTO `a``b`.`stage` (`invisible``column`, `default_expression`) SELECT `invisible``column`, `default_expression` FROM `a``b`.`source``table`");
    }

    async fn live_pool() -> Option<MySqlPool> {
        let url = match std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") {
            Ok(url) if !url.trim().is_empty() => url,
            _ => {
                eprintln!("Skipping opt-in MySQL native-copy integration test: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is unset");
                return None;
            }
        };
        Some(
            sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .expect("connect to the configured MySQL scratch database"),
        )
    }

    fn request(source: &str, target: &str) -> NativeCopyRequest {
        NativeCopyRequest {
            schema: None,
            source_table: source.into(),
            target_table: target.into(),
        }
    }

    #[tokio::test]
    async fn mysql_native_copy_live_no_pk_12001_rows_and_binary() {
        let Some(pool) = live_pool().await else {
            return;
        };
        let prefix = format!("rdb_native_{}", uuid::Uuid::new_v4().simple());
        let source = format!("{prefix}_s");
        let target = format!("{prefix}_t");
        let result: AppResult<()> = async {
            pool.execute(format!("CREATE TABLE {} (n INT, b VARBINARY(16), amount DECIMAL(32,10), nullable TEXT) ENGINE=InnoDB", ident(&source)).as_str()).await?;
            for start in (0..12001).step_by(500) {
                let values = (start..(start + 500).min(12001)).map(|n| format!("({n}, X'0001FF805C00', 12345678901234567890.1234567890, NULL)")).collect::<Vec<_>>().join(",");
                pool.execute(format!("INSERT INTO {} VALUES {values}", ident(&source)).as_str()).await?;
            }
            let request = request(&source, &target);
            let plan = preview(&pool, &request).await?;
            let report = execute(&pool, &request, &plan.fingerprint, CancellationToken::new(), std::sync::Arc::new(|_| {})).await?;
            assert_eq!(report.rows_copied, 12001);
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {} WHERE b = X'0001FF805C00' AND amount = 12345678901234567890.1234567890 AND nullable IS NULL", ident(&target))).fetch_one(&pool).await?;
            assert_eq!(count, 12001);
            Ok(())
        }.await;
        let _ = pool
            .execute(
                format!(
                    "DROP TABLE IF EXISTS {}, {}",
                    ident(&target),
                    ident(&source)
                )
                .as_str(),
            )
            .await;
        pool.close().await;
        result.unwrap();
    }

    #[tokio::test]
    async fn mysql_native_copy_live_auto_zero_generated_default_and_existing_target() {
        let Some(pool) = live_pool().await else {
            return;
        };
        let prefix = format!("rdb_native_{}", uuid::Uuid::new_v4().simple());
        let source = format!("{prefix}_s");
        let target = format!("{prefix}_t");
        let result: AppResult<()> = async {
            let options = pool.connect_options();
            let mut connection = MySqlConnection::connect_with(&options).await?;
            connection.execute("SET SESSION sql_mode = CONCAT_WS(',', @@sql_mode, 'NO_AUTO_VALUE_ON_ZERO')").await?;
            connection.execute(format!("CREATE TABLE {} (id BIGINT PRIMARY KEY AUTO_INCREMENT, n INT, calculated INT GENERATED ALWAYS AS (n * 2) STORED, stamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB AUTO_INCREMENT=700", ident(&source)).as_str()).await?;
            connection.execute(format!("INSERT INTO {} (id,n,stamp) VALUES (0,21,'2001-02-03 04:05:06'), (19,22,'2002-03-04 05:06:07')", ident(&source)).as_str()).await?;
            let request = request(&source, &target);
            let plan = preview(&pool, &request).await?;
            assert!(plan.statements.iter().any(|sql| sql.contains("`stamp`) SELECT")));
            execute(&pool, &request, &plan.fingerprint, CancellationToken::new(), std::sync::Arc::new(|_| {})).await?;
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {} WHERE id=0 AND n=21 AND calculated=42 AND stamp='2001-02-03 04:05:06'", ident(&target))).fetch_one(&pool).await?;
            assert_eq!(count, 1);
            let counter: Option<u64> = sqlx::query_scalar("SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?").bind(&target).fetch_one(&pool).await?;
            assert_eq!(counter, Some(700));
            assert!(execute(&pool, &request, &plan.fingerprint, CancellationToken::new(), std::sync::Arc::new(|_| {})).await.is_err());
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}", ident(&target))).fetch_one(&pool).await?;
            assert_eq!(count, 2);
            connection.close().await?;
            Ok(())
        }.await;
        let _ = pool
            .execute(
                format!(
                    "DROP TABLE IF EXISTS {}, {}",
                    ident(&target),
                    ident(&source)
                )
                .as_str(),
            )
            .await;
        pool.close().await;
        result.unwrap();
    }

    #[tokio::test]
    async fn mysql_native_copy_live_cancel_cleans_stage_and_ddl_invalidates_preview() {
        let Some(pool) = live_pool().await else {
            return;
        };
        let prefix = format!("rdb_native_{}", uuid::Uuid::new_v4().simple());
        let source = format!("{prefix}_s");
        let target = format!("{prefix}_t");
        let result: AppResult<()> = async {
            pool.execute(format!("CREATE TABLE {} (n INT) ENGINE=InnoDB COMMENT='{prefix}'", ident(&source)).as_str()).await?;
            let request = request(&source, &target);
            let plan = preview(&pool, &request).await?;
            let cancel = CancellationToken::new();
            let on_copy = cancel.clone();
            let progress: ProgressFn = std::sync::Arc::new(move |phase| {
                if matches!(phase, CopyPhase::Copying) { on_copy.cancel(); }
            });
            let outcome = execute(&pool, &request, &plan.fingerprint, cancel.clone(), progress).await;
            assert!(cancel.is_cancelled(), "the test must reach Copying before cancelling");
            assert_eq!(outcome.unwrap_err().to_string(), "table copy cancelled");
            let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_COMMENT=? AND TABLE_NAME<>?").bind(&prefix).bind(&source).fetch_one(&pool).await?;
            assert_eq!(remaining, 0, "cancellation must wait for stage cleanup");
            pool.execute(format!("ALTER TABLE {} ADD COLUMN changed INT", ident(&source)).as_str()).await?;
            assert!(execute(&pool, &request, &plan.fingerprint, CancellationToken::new(), std::sync::Arc::new(|_| {})).await.is_err());
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?").bind(&target).fetch_one(&pool).await?;
            assert_eq!(count, 0);
            Ok(())
        }.await;
        let _ = pool
            .execute(
                format!(
                    "DROP TABLE IF EXISTS {}, {}",
                    ident(&target),
                    ident(&source)
                )
                .as_str(),
            )
            .await;
        pool.close().await;
        result.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn mysql_native_copy_live_kills_blocked_insert_and_waits_for_cleanup() {
        use std::sync::{Arc, Condvar, Mutex};
        use std::time::Duration;

        let Some(pool) = live_pool().await else {
            return;
        };
        let prefix = format!("rdb_native_{}", uuid::Uuid::new_v4().simple());
        let source = format!("{prefix}_s");
        let target = format!("{prefix}_t");
        let result: AppResult<()> = async {
            pool.execute(format!("CREATE TABLE {} (n INT) ENGINE=InnoDB COMMENT='{prefix}'", ident(&source)).as_str()).await?;
            pool.execute(format!("INSERT INTO {} VALUES (1)", ident(&source)).as_str()).await?;
            let request = request(&source, &target);
            let plan = preview(&pool, &request).await?;
            let copying = Arc::new(tokio::sync::Notify::new());
            let cancelling = Arc::new(tokio::sync::Notify::new());
            let gate = Arc::new((Mutex::new(false), Condvar::new()));
            let progress: ProgressFn = {
                let copying = copying.clone();
                let cancelling = cancelling.clone();
                let gate = gate.clone();
                Arc::new(move |phase| match phase {
                    CopyPhase::Copying => {
                        copying.notify_one();
                        // Pause before INSERT, letting the test lock the exact
                        // stage. The timeout bounds failures in the test setup.
                        tokio::task::block_in_place(|| {
                            let (lock, ready) = &*gate;
                            let _ = ready.wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(15), |open| !*open).unwrap();
                        });
                    }
                    CopyPhase::Cancelling => cancelling.notify_one(),
                    _ => {}
                })
            };
            let cancel = CancellationToken::new();
            let job = {
                let pool = pool.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move { execute(&pool, &request, &plan.fingerprint, cancel, progress).await })
            };
            tokio::time::timeout(Duration::from_secs(15), copying.notified()).await.expect("copying phase");
            let stage: String = sqlx::query_scalar("SELECT CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_COMMENT=? AND TABLE_NAME<>?").bind(&prefix).bind(&source).fetch_one(&pool).await?;
            let options = pool.connect_options();
            let mut blocker = MySqlConnection::connect_with(&options).await?;
            blocker.execute(format!("LOCK TABLES {} WRITE", ident(&stage)).as_str()).await?;
            {
                let (lock, ready) = &*gate;
                *lock.lock().unwrap() = true;
                ready.notify_one();
            }
            let waiting = async {
                loop {
                    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND INFO LIKE ?")
                        .bind(format!("INSERT INTO %{}%", stage)).fetch_one(&pool).await?;
                    if count > 0 { return AppResult::Ok(()); }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            let waiting_result = tokio::time::timeout(Duration::from_secs(10), waiting).await;
            cancel.cancel();
            let observed_cancel = tokio::time::timeout(Duration::from_secs(10), cancelling.notified()).await;
            blocker.execute("UNLOCK TABLES").await?;
            blocker.close().await?;
            let outcome = tokio::time::timeout(Duration::from_secs(15), job).await.expect("cancel must finish cleanup").expect("copy task");
            waiting_result.expect("INSERT should wait on the test's table lock")?;
            observed_cancel.expect("KILL QUERY cancellation phase");
            assert_eq!(outcome.unwrap_err().to_string(), "table copy cancelled");
            let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_COMMENT=? AND TABLE_NAME<>?").bind(&prefix).bind(&source).fetch_one(&pool).await?;
            assert_eq!(remaining, 0);
            let target_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?").bind(&target).fetch_one(&pool).await?;
            assert_eq!(target_count, 0, "cancelled INSERT must not publish the target");
            Ok(())
        }.await;
        let _ = pool
            .execute(
                format!(
                    "DROP TABLE IF EXISTS {}, {}",
                    ident(&target),
                    ident(&source)
                )
                .as_str(),
            )
            .await;
        pool.close().await;
        result.unwrap();
    }
}
