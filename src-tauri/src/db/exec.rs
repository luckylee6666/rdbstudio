use crate::db::pool::DbPool;
use crate::db::redis_ops;
use crate::error::AppResult;
use serde::Serialize;
use serde_json::Value as Json;
use sqlx::{Column, Row, TypeInfo};
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Json>>,
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
}

pub fn is_readonly(sql: &str) -> bool {
    let lead: String = sql
        .trim_start()
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .to_uppercase();
    matches!(
        lead.as_str(),
        "SELECT" | "WITH" | "SHOW" | "PRAGMA" | "EXPLAIN" | "DESCRIBE" | "DESC" | "VALUES" | "TABLE"
    )
}

pub async fn execute(pool: &DbPool, sql: &str) -> AppResult<QueryResult> {
    // Redis: editor input is a raw command line, not SQL.
    if let DbPool::Redis(h) = pool {
        return redis_ops::execute(h, sql).await;
    }
    let start = Instant::now();
    if is_readonly(sql) {
        match pool {
            DbPool::Sqlite(p) => sqlite_select(p, sql, start).await,
            DbPool::Postgres(p) => pg_select(p, sql, start).await,
            DbPool::Mysql(p) => mysql_select(p, sql, start).await,
            DbPool::Redis(_) => unreachable!("handled above"),
        }
    } else {
        let rows_affected = match pool {
            DbPool::Sqlite(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Postgres(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Mysql(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Redis(_) => unreachable!("handled above"),
        };
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: Some(rows_affected),
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}

async fn sqlite_select(
    pool: &sqlx::SqlitePool,
    sql: &str,
    start: Instant,
) -> AppResult<QueryResult> {
    let rows = sqlx::query(sql).fetch_all(pool).await?;
    Ok(decode_sqlite(rows, start))
}

pub fn decode_sqlite(rows: Vec<sqlx::sqlite::SqliteRow>, start: Instant) -> QueryResult {
    let columns: Vec<ColumnMeta> = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| {
            (0..r.columns().len())
                .map(|i| sqlite_val(r, i))
                .collect::<Vec<_>>()
        })
        .collect();
    QueryResult {
        columns,
        rows: data,
        rows_affected: None,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }
}

fn sqlite_val(r: &sqlx::sqlite::SqliteRow, i: usize) -> Json {
    let col = &r.columns()[i];
    let ty = col.type_info().name();
    match ty {
        "INTEGER" | "INT" | "BIGINT" | "INT8" => try_i64(r, i)
            .or_else(|| try_bool(r, i))
            .unwrap_or(Json::Null),
        "REAL" | "FLOAT" | "DOUBLE" | "NUMERIC" => try_f64(r, i).unwrap_or(Json::Null),
        "TEXT" | "VARCHAR" | "CHAR" | "DATETIME" | "DATE" | "TIME" => {
            try_str(r, i).unwrap_or(Json::Null)
        }
        "BLOB" => try_bytes_b64(r, i).unwrap_or(Json::Null),
        // `""` (empty) and `"NULL"` come back for aggregates and dynamic exprs
        // (e.g. `SELECT count(*)`), where SQLite never set a declared affinity.
        // Probe i64 / f64 / String / bool in turn so the value lands instead of NULL.
        "" | "NULL" => try_i64(r, i)
            .or_else(|| try_f64(r, i))
            .or_else(|| try_str(r, i))
            .or_else(|| try_bool(r, i))
            .unwrap_or(Json::Null),
        _ => try_str(r, i)
            .or_else(|| try_i64(r, i))
            .or_else(|| try_f64(r, i))
            .unwrap_or(Json::Null),
    }
}

async fn pg_select(
    pool: &sqlx::PgPool,
    sql: &str,
    start: Instant,
) -> AppResult<QueryResult> {
    let rows = sqlx::query(sql).fetch_all(pool).await?;
    Ok(decode_postgres(rows, start))
}

pub fn decode_postgres(rows: Vec<sqlx::postgres::PgRow>, start: Instant) -> QueryResult {
    let columns: Vec<ColumnMeta> = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| {
            (0..r.columns().len())
                .map(|i| pg_val(r, i))
                .collect::<Vec<_>>()
        })
        .collect();
    QueryResult {
        columns,
        rows: data,
        rows_affected: None,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }
}

fn pg_val(r: &sqlx::postgres::PgRow, i: usize) -> Json {
    let ty = r.columns()[i].type_info().name().to_uppercase();
    match ty.as_str() {
        "BOOL" => try_bool(r, i).unwrap_or(Json::Null),
        "INT2" | "SMALLINT" => r
            .try_get::<Option<i16>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::from(v as i64))
            .unwrap_or(Json::Null),
        "INT4" | "INT" | "INTEGER" => r
            .try_get::<Option<i32>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::from(v as i64))
            .unwrap_or(Json::Null),
        "INT8" | "BIGINT" => try_i64(r, i).unwrap_or(Json::Null),
        "FLOAT4" | "REAL" => r
            .try_get::<Option<f32>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::from(v as f64))
            .unwrap_or(Json::Null),
        "FLOAT8" | "DOUBLE PRECISION" => try_f64(r, i).unwrap_or(Json::Null),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "CITEXT" => {
            try_str(r, i).unwrap_or(Json::Null)
        }
        "UUID" => r
            .try_get::<Option<sqlx::types::Uuid>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::String(v.to_string()))
            .unwrap_or(Json::Null),
        "JSON" | "JSONB" => r
            .try_get::<Option<Json>, _>(i)
            .ok()
            .flatten()
            .unwrap_or(Json::Null),
        "TIMESTAMP" | "TIMESTAMPTZ" | "DATE" | "TIME" | "TIMETZ" => r
            .try_get::<Option<chrono::NaiveDateTime>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::String(v.to_string()))
            .or_else(|| {
                r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)
                    .ok()
                    .flatten()
                    .map(|v| Json::String(v.to_rfc3339()))
            })
            .or_else(|| try_str(r, i))
            .unwrap_or(Json::Null),
        "BYTEA" => try_bytes_b64(r, i).unwrap_or(Json::Null),
        "NUMERIC" | "DECIMAL" | "MONEY" => try_str(r, i)
            .or_else(|| try_f64(r, i))
            .unwrap_or(Json::Null),
        _ => try_str(r, i)
            .or_else(|| try_i64(r, i))
            .or_else(|| try_f64(r, i))
            .unwrap_or(Json::Null),
    }
}

async fn mysql_select(
    pool: &sqlx::MySqlPool,
    sql: &str,
    start: Instant,
) -> AppResult<QueryResult> {
    let rows = sqlx::query(sql).fetch_all(pool).await?;
    Ok(decode_mysql(rows, start))
}

pub fn decode_mysql(rows: Vec<sqlx::mysql::MySqlRow>, start: Instant) -> QueryResult {
    let columns: Vec<ColumnMeta> = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| {
            (0..r.columns().len())
                .map(|i| mysql_val(r, i))
                .collect::<Vec<_>>()
        })
        .collect();
    QueryResult {
        columns,
        rows: data,
        rows_affected: None,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }
}

fn mysql_val(r: &sqlx::mysql::MySqlRow, i: usize) -> Json {
    let ty = r.columns()[i].type_info().name().to_uppercase();
    match ty.as_str() {
        "TINYINT" | "BOOLEAN" | "BOOL" => try_bool(r, i)
            .or_else(|| try_i64(r, i))
            .unwrap_or(Json::Null),
        "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => {
            try_i64(r, i).unwrap_or(Json::Null)
        }
        "FLOAT" | "DOUBLE" => try_f64(r, i).unwrap_or(Json::Null),
        "DECIMAL" | "NUMERIC" => try_str(r, i)
            .or_else(|| try_f64(r, i))
            .unwrap_or(Json::Null),
        "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM"
        | "SET" => try_str(r, i).unwrap_or(Json::Null),
        "DATE" | "TIME" | "YEAR" | "DATETIME" | "TIMESTAMP" => r
            .try_get::<Option<chrono::NaiveDateTime>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::String(v.to_string()))
            .or_else(|| try_str(r, i))
            .unwrap_or(Json::Null),
        "JSON" => r
            .try_get::<Option<Json>, _>(i)
            .ok()
            .flatten()
            .unwrap_or(Json::Null),
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => {
            try_bytes_b64(r, i).unwrap_or(Json::Null)
        }
        _ => try_str(r, i)
            .or_else(|| try_i64(r, i))
            .or_else(|| try_f64(r, i))
            .unwrap_or(Json::Null),
    }
}

fn try_i64<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    i64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<i64>, _>(i)
        .ok()
        .flatten()
        .map(Json::from)
}

fn try_f64<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    f64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<f64>, _>(i)
        .ok()
        .flatten()
        .and_then(|v| serde_json::Number::from_f64(v).map(Json::Number))
}

fn try_str<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    String: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<String>, _>(i)
        .ok()
        .flatten()
        .map(Json::String)
}

fn try_bool<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    bool: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<bool>, _>(i)
        .ok()
        .flatten()
        .map(Json::Bool)
}

fn try_bytes_b64<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    Vec<u8>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<Vec<u8>>, _>(i)
        .ok()
        .flatten()
        .map(|v| Json::String(base64_like(&v)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_readonly_recognizes_select() {
        assert!(is_readonly("SELECT * FROM users"));
        assert!(is_readonly("select 1"));
        assert!(is_readonly("  SeLeCt 1"));
    }

    #[test]
    fn is_readonly_recognizes_with_and_show_pragma() {
        assert!(is_readonly("with x as (select 1) select * from x"));
        assert!(is_readonly("SHOW TABLES"));
        assert!(is_readonly("PRAGMA table_info(users)"));
        assert!(is_readonly("EXPLAIN SELECT 1"));
        assert!(is_readonly("describe users"));
    }

    #[test]
    fn is_readonly_rejects_dml_and_ddl() {
        assert!(!is_readonly("INSERT INTO users VALUES (1)"));
        assert!(!is_readonly("update users set x=1"));
        assert!(!is_readonly("  DELETE FROM users"));
        assert!(!is_readonly("CREATE TABLE x (a int)"));
        assert!(!is_readonly("DROP TABLE x"));
    }
}

fn base64_like(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3 + 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
        out.push(CHARS[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}
