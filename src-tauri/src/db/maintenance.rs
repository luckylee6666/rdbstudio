//! Fixed, identifier-safe table maintenance operations.

use crate::db::data::quote_ident;
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceAction {
    AnalyzeTable,
    OptimizeTable,
    VacuumDatabase,
}

#[derive(Debug, Clone, Serialize)]
pub struct MaintenanceReport {
    pub action: MaintenanceAction,
    pub message: String,
    pub elapsed_ms: u64,
}

fn target(driver: DriverKind, schema: Option<&str>, table: Option<&str>) -> AppResult<String> {
    let table = table
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::msg("this maintenance operation requires a table"))?;
    Ok(match schema.filter(|name| !name.is_empty()) {
        Some(schema) => format!(
            "{}.{}",
            quote_ident(driver, schema),
            quote_ident(driver, table)
        ),
        None => quote_ident(driver, table),
    })
}

pub fn statement(
    driver: DriverKind,
    action: MaintenanceAction,
    schema: Option<&str>,
    table: Option<&str>,
) -> AppResult<String> {
    let sql = match (driver, action) {
        (DriverKind::Postgres, MaintenanceAction::AnalyzeTable) => {
            format!("ANALYZE {}", target(driver, schema, table)?)
        }
        (DriverKind::Postgres, MaintenanceAction::OptimizeTable) => {
            format!("VACUUM (ANALYZE) {}", target(driver, schema, table)?)
        }
        (DriverKind::Sqlite, MaintenanceAction::AnalyzeTable) => {
            format!("ANALYZE {}", target(driver, schema, table)?)
        }
        (DriverKind::Sqlite, MaintenanceAction::VacuumDatabase) => {
            if schema.is_some_and(|name| name != "main") || table.is_some() {
                return Err(AppError::msg(
                    "SQLite VACUUM targets the main database and must not specify a table",
                ));
            }
            "VACUUM".into()
        }
        (DriverKind::Mysql, MaintenanceAction::AnalyzeTable) => {
            format!("ANALYZE TABLE {}", target(driver, schema, table)?)
        }
        (DriverKind::Mysql, MaintenanceAction::OptimizeTable) => {
            format!("OPTIMIZE TABLE {}", target(driver, schema, table)?)
        }
        (DriverKind::Redis, _) => {
            return Err(AppError::msg(
                "table maintenance is not supported for Redis",
            ))
        }
        (DriverKind::Postgres | DriverKind::Mysql, MaintenanceAction::VacuumDatabase) => {
            return Err(AppError::msg(
                "database-wide VACUUM is only supported for SQLite",
            ));
        }
        (DriverKind::Sqlite, MaintenanceAction::OptimizeTable) => {
            return Err(AppError::msg(
                "OPTIMIZE TABLE is only supported for PostgreSQL and MySQL",
            ));
        }
    };
    Ok(sql)
}

/// Run one fixed maintenance operation. PostgreSQL VACUUM is sent directly to
/// the pool without opening a transaction, as required by the server.
pub async fn run(
    pool: &DbPool,
    action: MaintenanceAction,
    schema: Option<&str>,
    table: Option<&str>,
) -> AppResult<String> {
    let sql = statement(pool.driver(), action, schema, table)?;
    match pool {
        DbPool::Sqlite(pool) => {
            sqlx::raw_sql(&sql).execute(pool).await?;
            Ok(match action {
                MaintenanceAction::VacuumDatabase => {
                    "VACUUM completed for the current database".into()
                }
                _ => "ANALYZE completed".into(),
            })
        }
        DbPool::Postgres(pool) => {
            sqlx::raw_sql(&sql).execute(pool).await?;
            Ok(match action {
                MaintenanceAction::AnalyzeTable => "ANALYZE completed".into(),
                MaintenanceAction::OptimizeTable => "VACUUM (ANALYZE) completed".into(),
                MaintenanceAction::VacuumDatabase => unreachable!("validated by statement"),
            })
        }
        DbPool::Mysql(pool) => {
            let rows = sqlx::raw_sql(&sql).fetch_all(pool).await?;
            let mut messages = Vec::with_capacity(rows.len());
            let mut failures = Vec::new();
            for row in rows {
                let msg_type: Option<String> = row.try_get("Msg_type")?;
                let message: Option<String> = row.try_get("Msg_text")?;
                let table_name: Option<String> = row.try_get("Table")?;
                let msg_type = msg_type.unwrap_or_else(|| "status".into());
                let message = message.unwrap_or_default();
                let table_name = table_name.unwrap_or_else(|| "table".into());
                if msg_type.eq_ignore_ascii_case("error") {
                    failures.push(format!("{table_name}: {message}"));
                }
                messages.push(format!("{table_name}: {msg_type} — {message}"));
            }
            if !failures.is_empty() {
                return Err(AppError::msg(format!(
                    "MySQL maintenance failed: {}",
                    failures.join("; ")
                )));
            }
            if messages.is_empty() {
                return Err(AppError::msg("MySQL maintenance returned no status rows"));
            }
            Ok(messages.join("; "))
        }
        DbPool::Redis(_) => Err(AppError::msg(
            "table maintenance is not supported for Redis",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_names_and_maps_supported_driver_actions() {
        assert_eq!(
            statement(
                DriverKind::Postgres,
                MaintenanceAction::AnalyzeTable,
                Some("odd\"schema"),
                Some("a\"b")
            )
            .unwrap(),
            "ANALYZE \"odd\"\"schema\".\"a\"\"b\""
        );
        assert_eq!(
            statement(
                DriverKind::Postgres,
                MaintenanceAction::OptimizeTable,
                Some("public"),
                Some("items")
            )
            .unwrap(),
            "VACUUM (ANALYZE) \"public\".\"items\""
        );
        assert_eq!(
            statement(
                DriverKind::Mysql,
                MaintenanceAction::AnalyzeTable,
                Some("app"),
                Some("items")
            )
            .unwrap(),
            "ANALYZE TABLE `app`.`items`"
        );
        assert_eq!(
            statement(
                DriverKind::Mysql,
                MaintenanceAction::OptimizeTable,
                Some("app"),
                Some("items")
            )
            .unwrap(),
            "OPTIMIZE TABLE `app`.`items`"
        );
        assert_eq!(
            statement(
                DriverKind::Sqlite,
                MaintenanceAction::AnalyzeTable,
                None,
                Some("items")
            )
            .unwrap(),
            "ANALYZE \"items\""
        );
        assert_eq!(
            statement(
                DriverKind::Sqlite,
                MaintenanceAction::VacuumDatabase,
                None,
                None
            )
            .unwrap(),
            "VACUUM"
        );
    }

    #[test]
    fn rejects_unsupported_actions_and_missing_table() {
        assert!(statement(
            DriverKind::Postgres,
            MaintenanceAction::VacuumDatabase,
            None,
            None
        )
        .is_err());
        assert!(statement(
            DriverKind::Mysql,
            MaintenanceAction::VacuumDatabase,
            None,
            None
        )
        .is_err());
        assert!(statement(
            DriverKind::Sqlite,
            MaintenanceAction::OptimizeTable,
            None,
            Some("t")
        )
        .is_err());
        assert!(statement(
            DriverKind::Sqlite,
            MaintenanceAction::AnalyzeTable,
            None,
            None
        )
        .is_err());
        assert!(statement(
            DriverKind::Redis,
            MaintenanceAction::AnalyzeTable,
            None,
            Some("t")
        )
        .is_err());
        assert!(statement(
            DriverKind::Sqlite,
            MaintenanceAction::VacuumDatabase,
            Some("other"),
            None
        )
        .is_err());
        assert!(statement(
            DriverKind::Sqlite,
            MaintenanceAction::VacuumDatabase,
            None,
            Some("t")
        )
        .is_err());
    }

    #[tokio::test]
    async fn sqlite_analyze_table_and_vacuum_database_execute() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE \"odd\"\"table\" (id INTEGER PRIMARY KEY, value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO \"odd\"\"table\" VALUES (1, 'kept')")
            .execute(&pool)
            .await
            .unwrap();
        let wrapped = DbPool::Sqlite(pool.clone());

        let message = run(
            &wrapped,
            MaintenanceAction::AnalyzeTable,
            None,
            Some("odd\"table"),
        )
        .await
        .unwrap();
        assert!(message.contains("ANALYZE"));
        let analyzed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = ?")
            .bind("odd\"table")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(analyzed, 1);

        let message = run(&wrapped, MaintenanceAction::VacuumDatabase, None, None)
            .await
            .unwrap();
        assert!(message.contains("current database"));
        pool.close().await;
    }
}
