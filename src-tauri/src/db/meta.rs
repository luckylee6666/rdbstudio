use crate::db::pool::DbPool;
use crate::db::redis_ops;
use crate::error::AppResult;
use crate::model::{ColumnInfo, TreeEntry};
use sqlx::Row;

pub async fn server_version(pool: &DbPool) -> AppResult<String> {
    let v = match pool {
        DbPool::Sqlite(p) => {
            let row = sqlx::query("SELECT sqlite_version() AS v").fetch_one(p).await?;
            let s: String = row.try_get("v")?;
            format!("SQLite {}", s)
        }
        DbPool::Postgres(p) => {
            let row = sqlx::query("SELECT version() AS v").fetch_one(p).await?;
            row.try_get::<String, _>("v")?
        }
        DbPool::Mysql(p) => {
            let row = sqlx::query("SELECT version() AS v").fetch_one(p).await?;
            row.try_get::<String, _>("v")?
        }
        DbPool::Redis(h) => redis_ops::server_version(h).await?,
    };
    Ok(v)
}

pub async fn list_databases(pool: &DbPool) -> AppResult<Vec<String>> {
    match pool {
        DbPool::Sqlite(_) => Ok(vec!["main".into()]),
        DbPool::Redis(h) => redis_ops::list_databases(h).await,
        DbPool::Postgres(p) => {
            // A PG pool is bound to one database; expose schemas as the
            // browsable containers instead of unreachable sibling databases.
            let rows = sqlx::query(
                "SELECT nspname FROM pg_namespace \
                 WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND nspname <> 'information_schema' \
                 ORDER BY nspname",
            )
            .fetch_all(p)
            .await?;
            Ok(rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
        }
        DbPool::Mysql(p) => {
            let rows = sqlx::query(
                "SELECT schema_name FROM information_schema.schemata \
                 WHERE schema_name NOT IN ('mysql','performance_schema','information_schema','sys') \
                 ORDER BY schema_name",
            )
            .fetch_all(p)
            .await?;
            Ok(rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
        }
    }
}

pub async fn list_schemas(pool: &DbPool, _database: Option<&str>) -> AppResult<Vec<String>> {
    match pool {
        DbPool::Sqlite(_) => Ok(vec!["main".into()]),
        DbPool::Redis(_) => Ok(vec!["db0".into()]),
        DbPool::Postgres(p) => {
            let rows = sqlx::query(
                "SELECT nspname FROM pg_namespace \
                 WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND nspname <> 'information_schema' \
                 ORDER BY nspname",
            )
            .fetch_all(p)
            .await?;
            Ok(rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
        }
        DbPool::Mysql(_) => Ok(vec![]),
    }
}

pub async fn list_tables(
    pool: &DbPool,
    schema: Option<&str>,
) -> AppResult<Vec<TreeEntry>> {
    match pool {
        DbPool::Redis(h) => redis_ops::list_keys(h).await,
        DbPool::Sqlite(p) => {
            let rows = sqlx::query(
                "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get("name").ok()?;
                    let kind: String = r.try_get("type").ok()?;
                    Some(TreeEntry {
                        name,
                        kind,
                        schema: None,
                        comment: None,
                        ttl_ms: None,
                    })
                })
                .collect())
        }
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or("public");
            let rows = sqlx::query(
                "SELECT table_name, table_type FROM information_schema.tables \
                 WHERE table_schema = $1 ORDER BY table_name",
            )
            .bind(schema)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get("table_name").ok()?;
                    let ty: String = r.try_get("table_type").ok()?;
                    let kind = if ty == "VIEW" { "view" } else { "table" };
                    Some(TreeEntry {
                        name,
                        kind: kind.into(),
                        schema: Some(schema.into()),
                        comment: None,
                        ttl_ms: None,
                    })
                })
                .collect())
        }
        DbPool::Mysql(p) => {
            let sql = match schema {
                Some(s) => format!("SHOW FULL TABLES FROM `{}`", s.replace('`', "``")),
                None => "SHOW FULL TABLES".to_string(),
            };
            let rows = sqlx::query(&sql).fetch_all(p).await?;
            let schema_label = schema.map(String::from);
            Ok(rows
                .iter()
                .filter_map(|r| {
                    // First column is "Tables_in_<db>" — name varies per db, so use positional index.
                    let name: String = r.try_get::<String, _>(0).ok()?;
                    let ty: String = r.try_get::<String, _>(1).unwrap_or_default();
                    let kind = if ty.to_uppercase().contains("VIEW") { "view" } else { "table" };
                    Some(TreeEntry {
                        name,
                        kind: kind.into(),
                        schema: schema_label.clone(),
                        comment: None,
                        ttl_ms: None,
                    })
                })
                .collect())
        }
    }
}

pub async fn list_columns(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<Vec<ColumnInfo>> {
    match pool {
        // Redis keys are not column-shaped — return empty so callers that
        // optimistically request column metadata simply get nothing.
        DbPool::Redis(_) => Ok(vec![]),
        DbPool::Sqlite(p) => {
            let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
            let rows = sqlx::query(&sql).fetch_all(p).await?;
            Ok(rows
                .iter()
                .map(|r| ColumnInfo {
                    name: r.try_get::<String, _>("name").unwrap_or_default(),
                    data_type: r.try_get::<String, _>("type").unwrap_or_default(),
                    nullable: r.try_get::<i64, _>("notnull").unwrap_or(0) == 0,
                    is_primary_key: r.try_get::<i64, _>("pk").unwrap_or(0) > 0,
                    default_value: r.try_get::<Option<String>, _>("dflt_value").ok().flatten(),
                })
                .collect())
        }
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or("public");
            let rows = sqlx::query(
                "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
                        COALESCE(k.is_pk, false) AS is_pk \
                 FROM information_schema.columns c \
                 LEFT JOIN ( \
                    SELECT kcu.column_name, true AS is_pk \
                    FROM information_schema.table_constraints tc \
                    JOIN information_schema.key_column_usage kcu \
                      ON tc.constraint_name = kcu.constraint_name \
                     AND tc.table_schema = kcu.table_schema \
                    WHERE tc.table_schema = $1 AND tc.table_name = $2 \
                      AND tc.constraint_type = 'PRIMARY KEY' \
                 ) k ON k.column_name = c.column_name \
                 WHERE c.table_schema = $1 AND c.table_name = $2 \
                 ORDER BY c.ordinal_position",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .map(|r| ColumnInfo {
                    name: r.try_get::<String, _>("column_name").unwrap_or_default(),
                    data_type: r.try_get::<String, _>("data_type").unwrap_or_default(),
                    nullable: r
                        .try_get::<String, _>("is_nullable")
                        .map(|s| s == "YES")
                        .unwrap_or(true),
                    is_primary_key: r.try_get::<bool, _>("is_pk").unwrap_or(false),
                    default_value: r.try_get::<Option<String>, _>("column_default").ok().flatten(),
                })
                .collect())
        }
        DbPool::Mysql(p) => {
            // SHOW FULL COLUMNS respects ACLs reliably and ignores the connection's
            // current database. Columns returned: Field, Type, Collation, Null, Key,
            // Default, Extra, Privileges, Comment.
            let sql = match schema {
                Some(s) => format!(
                    "SHOW FULL COLUMNS FROM `{}` FROM `{}`",
                    table.replace('`', "``"),
                    s.replace('`', "``")
                ),
                None => format!("SHOW FULL COLUMNS FROM `{}`", table.replace('`', "``")),
            };
            let rows = sqlx::query(&sql).fetch_all(p).await?;
            Ok(rows
                .iter()
                .map(|r| {
                    let key: String = r
                        .try_get::<String, _>("Key")
                        .or_else(|_| r.try_get::<String, _>(4))
                        .unwrap_or_default();
                    ColumnInfo {
                        name: r
                            .try_get::<String, _>("Field")
                            .or_else(|_| r.try_get::<String, _>(0))
                            .unwrap_or_default(),
                        data_type: r
                            .try_get::<String, _>("Type")
                            .or_else(|_| r.try_get::<String, _>(1))
                            .unwrap_or_default(),
                        nullable: r
                            .try_get::<String, _>("Null")
                            .or_else(|_| r.try_get::<String, _>(3))
                            .map(|s| s.eq_ignore_ascii_case("YES"))
                            .unwrap_or(true),
                        is_primary_key: key == "PRI",
                        default_value: r
                            .try_get::<Option<String>, _>("Default")
                            .or_else(|_| r.try_get::<Option<String>, _>(5))
                            .ok()
                            .flatten(),
                    }
                })
                .collect())
        }
    }
}
