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
    /// True when a SELECT produced more than `MAX_ROWS` rows and the tail was
    /// dropped to protect memory / the IPC bridge.
    pub truncated: bool,
}

/// Hard cap on rows a single editor query returns. Anything above this is cut
/// off and flagged via `QueryResult::truncated` — an unbounded `SELECT *` on a
/// large table would otherwise decode fully into memory and freeze the UI.
pub const MAX_ROWS: usize = 10_000;

/// Skip leading whitespace, SQL comments (`--`, `/* */`), and opening parens
/// so scripts like `-- note\nSELECT 1` or `(SELECT 1)` classify like a plain
/// SELECT instead of falling into the write branch (which returns no rows).
fn skip_leading_trivia(sql: &str) -> &str {
    let mut s = sql;
    loop {
        let t = s.trim_start();
        if let Some(rest) = t.strip_prefix("--") {
            s = rest.split_once('\n').map(|(_, r)| r).unwrap_or("");
        } else if let Some(rest) = t.strip_prefix("/*") {
            s = rest.split_once("*/").map(|(_, r)| r).unwrap_or("");
        } else if let Some(rest) = t.strip_prefix('(') {
            s = rest;
        } else {
            return t;
        }
    }
}

pub fn is_readonly(sql: &str) -> bool {
    let lead: String = skip_leading_trivia(sql)
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .to_uppercase();
    matches!(
        lead.as_str(),
        "SELECT" | "WITH" | "SHOW" | "PRAGMA" | "EXPLAIN" | "DESCRIBE" | "DESC" | "VALUES" | "TABLE"
    )
}

/// True when a DML statement carries a RETURNING clause (PG/SQLite). Those
/// produce rows and must go through the fetch path — the execute branch would
/// drop them and the user would only see "N affected". Scans word-by-word,
/// skipping string/identifier literals and comments so `'RETURNING'` inside a
/// value can't false-positive.
fn has_returning(sql: &str) -> bool {
    let mut chars = sql.chars().peekable();
    let mut word = String::new();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' | '`' => {
                // Skip the quoted literal/identifier; a doubled quote escapes.
                while let Some(n) = chars.next() {
                    if n == c {
                        if chars.peek() == Some(&c) {
                            chars.next();
                        } else {
                            break;
                        }
                    }
                }
                word.clear();
            }
            '-' if chars.peek() == Some(&'-') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        break;
                    }
                }
                word.clear();
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
                word.clear();
            }
            c if c.is_alphanumeric() || c == '_' => word.push(c.to_ascii_uppercase()),
            _ => {
                if word == "RETURNING" {
                    return true;
                }
                word.clear();
            }
        }
    }
    word == "RETURNING"
}

/// Drain up to `MAX_ROWS` rows from a fetch stream; returns the rows plus
/// whether the stream had more (i.e. the result was truncated).
async fn fetch_capped<T>(
    mut stream: futures::stream::BoxStream<'_, Result<T, sqlx::Error>>,
) -> AppResult<(Vec<T>, bool)> {
    use futures::TryStreamExt;
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(row) = stream.try_next().await? {
        if rows.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        rows.push(row);
    }
    Ok((rows, truncated))
}

pub async fn execute(pool: &DbPool, sql: &str) -> AppResult<QueryResult> {
    // Redis: editor input is a raw command line, not SQL.
    if let DbPool::Redis(h) = pool {
        return redis_ops::execute(h, sql).await;
    }
    let start = Instant::now();
    if is_readonly(sql) || has_returning(sql) {
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
            truncated: false,
        })
    }
}

async fn sqlite_select(
    pool: &sqlx::SqlitePool,
    sql: &str,
    start: Instant,
) -> AppResult<QueryResult> {
    let (rows, truncated) = fetch_capped(sqlx::query(sql).fetch(pool)).await?;
    let mut out = decode_sqlite(rows, start);
    out.truncated = truncated;
    Ok(out)
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
        truncated: false,
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
    let (rows, truncated) = fetch_capped(sqlx::query(sql).fetch(pool)).await?;
    let mut out = decode_postgres(rows, start);
    out.truncated = truncated;
    Ok(out)
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
        truncated: false,
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
    let (rows, truncated) = fetch_capped(sqlx::query(sql).fetch(pool)).await?;
    let mut out = decode_mysql(rows, start);
    out.truncated = truncated;
    Ok(out)
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
        truncated: false,
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

fn base64_like(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3) + 4);
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

    #[test]
    fn is_readonly_sees_past_comments_and_parens() {
        assert!(is_readonly("-- note\nSELECT 1"));
        assert!(is_readonly("/* block */ SELECT 1"));
        assert!(is_readonly("/* multi\nline */\n-- and line\nSELECT 1"));
        assert!(is_readonly("(SELECT 1)"));
        assert!(is_readonly("((select 1))"));
        assert!(!is_readonly("-- note\nDELETE FROM x"));
        assert!(!is_readonly("/* c */ UPDATE x SET a=1"));
        // Unterminated trivia degrades to "not readonly", never panics.
        assert!(!is_readonly("-- only a comment"));
        assert!(!is_readonly("/* unterminated"));
    }

    #[test]
    fn has_returning_detects_clause_outside_literals() {
        assert!(has_returning("INSERT INTO t (a) VALUES (1) RETURNING id"));
        assert!(has_returning("update t set a=1 returning *"));
        assert!(has_returning("DELETE FROM t WHERE id=1 RETURNING id;"));
        assert!(has_returning("insert into t values (1)\nRETURNING id"));

        assert!(!has_returning("INSERT INTO t (a) VALUES ('RETURNING')"));
        assert!(!has_returning("INSERT INTO t (a) VALUES (1) -- returning?"));
        assert!(!has_returning("/* returning */ INSERT INTO t VALUES (1)"));
        assert!(!has_returning("UPDATE t SET returning1 = 2"));
        assert!(!has_returning("UPDATE \"returning\" SET a = 2"));
        assert!(!has_returning("SELECT 1"));
    }
}
