use crate::db::pool::DbPool;
use crate::db::redis_ops;
use crate::error::{AppError, AppResult};
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

fn first_keyword(sql: &str) -> String {
    skip_leading_trivia(sql)
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .to_uppercase()
}

fn skip_first_keyword(sql: &str) -> &str {
    let s = skip_leading_trivia(sql);
    let bytes: usize = s
        .chars()
        .take_while(|c| c.is_alphabetic())
        .map(|c| c.len_utf8())
        .sum();
    &s[bytes..]
}

/// SELECT / VALUES / TABLE can still write via `INTO` (PG `SELECT … INTO`,
/// MySQL `SELECT … INTO OUTFILE`). Failure mode of a false positive is a
/// blocked read, never a write slipping through.
fn has_into_clause(sql: &str) -> bool {
    scan_bare_words(sql, |w| w == "INTO")
}

fn writes_via_dml_or_into(sql: &str) -> bool {
    scan_bare_words(sql, |w| {
        matches!(w, "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "INTO")
    })
}

/// `EXPLAIN` itself is a read. `EXPLAIN ANALYZE` (or `EXPLAIN (ANALYZE …)`
/// with ANALYZE not explicitly false) *runs* the inner statement, so a
/// read-only connection must classify the inner SQL.
fn explain_is_readonly(sql: &str) -> bool {
    let after = skip_first_keyword(sql).trim_start();
    let (analyze, body) = if let Some(rest) = after.strip_prefix('(') {
        explain_paren_options(rest)
    } else {
        explain_bare_options(after)
    };
    if analyze {
        is_readonly(body)
    } else {
        true
    }
}

fn explain_paren_options(s: &str) -> (bool, &str) {
    match s.find(')') {
        Some(idx) => {
            let analyze = explain_analyze_enabled(&s[..idx]);
            (analyze, s[idx + 1..].trim_start())
        }
        // Unterminated options → treat as ANALYZE so the inner (or leftover)
        // statement is classified; unknown leftovers classify as writes.
        None => (true, s),
    }
}

fn explain_bare_options(s: &str) -> (bool, &str) {
    let mut rest = s;
    let mut analyze = false;
    loop {
        let t = rest.trim_start();
        let u = t.to_ascii_uppercase();
        if u.starts_with("QUERY") {
            let after = t["QUERY".len()..].trim_start();
            if after.to_ascii_uppercase().starts_with("PLAN") {
                rest = after["PLAN".len()..].trim_start();
                continue;
            }
        }
        if u.starts_with("ANALYZE") {
            rest = t["ANALYZE".len()..].trim_start();
            let next = rest.to_ascii_uppercase();
            if next.starts_with("FALSE") || next.starts_with("OFF") || next.starts_with('0') {
                analyze = false;
                rest = skip_token(rest);
            } else if next.starts_with("TRUE") || next.starts_with("ON") || next.starts_with('1') {
                analyze = true;
                rest = skip_token(rest);
            } else {
                analyze = true;
            }
            continue;
        }
        if u.starts_with("VERBOSE") {
            rest = t["VERBOSE".len()..].trim_start();
            continue;
        }
        if u.starts_with("FORMAT") {
            rest = t["FORMAT".len()..].trim_start();
            if let Some(r) = rest.strip_prefix('=') {
                rest = r.trim_start();
            }
            rest = skip_token(rest);
            continue;
        }
        return (analyze, t);
    }
}

fn explain_analyze_enabled(opts: &str) -> bool {
    let tokens: Vec<String> = opts
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_uppercase())
        .collect();
    let mut i = 0;
    let mut analyze = false;
    while i < tokens.len() {
        if tokens[i] == "ANALYZE" {
            match tokens.get(i + 1).map(String::as_str) {
                Some("FALSE") | Some("OFF") | Some("0") => {
                    analyze = false;
                    i += 2;
                    continue;
                }
                Some("TRUE") | Some("ON") | Some("1") => {
                    analyze = true;
                    i += 2;
                    continue;
                }
                _ => analyze = true,
            }
        }
        i += 1;
    }
    analyze
}

fn skip_token(s: &str) -> &str {
    let t = s.trim_start();
    let bytes: usize = t
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .map(|c| c.len_utf8())
        .sum();
    t[bytes..].trim_start()
}

/// SQLite PRAGMA is a grab-bag: `table_info(t)` is a read, while both
/// `journal_mode=WAL` and `journal_mode(WAL)` mutate. Fail closed for the
/// parenthesized form and only allow names whose argument is purely a lookup.
fn pragma_is_readonly(sql: &str) -> bool {
    let rest = skip_first_keyword(sql).trim_start();
    let name = pragma_name(rest);
    const MUTATING: &[&str] = &[
        "WAL_CHECKPOINT",
        "OPTIMIZE",
        "INCREMENTAL_VACUUM",
        "SHRINK_MEMORY",
    ];
    if MUTATING.contains(&name.as_str()) {
        return false;
    }
    if pragma_has_assignment(rest) {
        return false;
    }
    if pragma_has_argument(rest) {
        const READ_WITH_ARGUMENT: &[&str] = &[
            "FOREIGN_KEY_CHECK",
            "FOREIGN_KEY_LIST",
            "INDEX_INFO",
            "INDEX_LIST",
            "INDEX_XINFO",
            "INTEGRITY_CHECK",
            "QUICK_CHECK",
            "TABLE_INFO",
            "TABLE_XINFO",
        ];
        return READ_WITH_ARGUMENT.contains(&name.as_str());
    }
    true
}

fn pragma_name(s: &str) -> String {
    // `schema.pragma` or just `pragma`
    let ident = |src: &str| {
        src.chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect::<String>()
            .to_ascii_uppercase()
    };
    let first = ident(s);
    let after = s.get(first.len()..).unwrap_or("").trim_start();
    if let Some(rest) = after.strip_prefix('.') {
        ident(rest)
    } else {
        first
    }
}

fn pragma_has_assignment(s: &str) -> bool {
    pragma_suffix(s).contains('=')
}

fn pragma_has_argument(s: &str) -> bool {
    pragma_suffix(s).starts_with('(')
}

fn pragma_suffix(s: &str) -> &str {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
            i += 1;
        }
    }
    s.get(i..).unwrap_or("").trim_start()
}

pub fn is_readonly(sql: &str) -> bool {
    match first_keyword(sql).as_str() {
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "VALUES" | "TABLE" => !has_into_clause(sql),
        "PRAGMA" => pragma_is_readonly(sql),
        "EXPLAIN" => explain_is_readonly(sql),
        // Postgres allows data-modifying CTEs — `WITH d AS (DELETE ...) SELECT`
        // leads with WITH but writes. Only trust a leading WITH when no DML
        // keyword appears as a bare word anywhere in the statement. This can
        // misclassify a read-only query that quotes such a word oddly, but the
        // failure mode is "read blocked on a read-only connection", never a
        // write slipping through.
        "WITH" => !writes_via_dml_or_into(sql),
        _ => false,
    }
}

/// True when a DML statement carries a RETURNING clause (PG/SQLite). Those
/// produce rows and must go through the fetch path — the execute branch would
/// drop them and the user would only see "N affected".
fn has_returning(sql: &str) -> bool {
    scan_bare_words(sql, |w| w == "RETURNING")
}

/// Scan a statement's bare words — outside string/identifier literals and
/// comments — uppercased, returning true the first time `pred` matches.
/// Postgres `E'...'` escape strings honor backslash escapes so `E'O\'Brien'`
/// doesn't desync the literal tracking.
fn scan_bare_words(sql: &str, pred: impl Fn(&str) -> bool) -> bool {
    let mut chars = sql.chars().peekable();
    let mut word = String::new();
    while let Some(c) = chars.next() {
        match c {
            // PG escape string: the E prefix is sitting in `word` when we hit
            // the opening quote; inside, a backslash escapes the next char.
            '\'' if word == "E" => {
                let mut escaped = false;
                while let Some(n) = chars.next() {
                    if escaped {
                        escaped = false;
                        continue;
                    }
                    match n {
                        '\\' => escaped = true,
                        '\'' => {
                            if chars.peek() == Some(&'\'') {
                                chars.next();
                            } else {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                word.clear();
            }
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
            '$' => {
                if !word.is_empty() && pred(&word) {
                    return true;
                }
                word.clear();
                match chars.peek().copied() {
                    Some(c) if c.is_ascii_digit() => {
                        // `$1` is a placeholder, not a dollar-quote.
                    }
                    Some('$') => {
                        chars.next();
                        skip_dollar_quoted(&mut chars, "");
                    }
                    Some(c) if c.is_ascii_alphabetic() || c == '_' => {
                        let mut tag = String::new();
                        while let Some(n) = chars.peek().copied() {
                            if n == '$' {
                                chars.next();
                                skip_dollar_quoted(&mut chars, &tag);
                                break;
                            }
                            if n.is_ascii_alphanumeric() || n == '_' {
                                tag.push(n);
                                chars.next();
                            } else {
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
            c if c.is_alphanumeric() || c == '_' => word.push(c.to_ascii_uppercase()),
            _ => {
                if !word.is_empty() && pred(&word) {
                    return true;
                }
                word.clear();
            }
        }
    }
    !word.is_empty() && pred(&word)
}

/// Skip the body of a `$tag$ … $tag$` dollar-quoted string (Postgres).
fn skip_dollar_quoted(chars: &mut std::iter::Peekable<impl Iterator<Item = char>>, tag: &str) {
    loop {
        match chars.next() {
            None => return,
            Some('$') => {
                let mut ok = true;
                for expected in tag.chars() {
                    match chars.peek().copied() {
                        Some(c) if c == expected => {
                            chars.next();
                        }
                        _ => {
                            ok = false;
                            break;
                        }
                    }
                }
                if ok && chars.peek() == Some(&'$') {
                    chars.next();
                    return;
                }
            }
            _ => {}
        }
    }
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

/// Outcome of a multi-statement script run inside one transaction. `Failed`
/// is a normal return, not an `Err` — the frontend needs the failing index
/// plus the guarantee that every earlier statement was rolled back.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ScriptOutcome {
    Ok {
        result: QueryResult,
        total_affected: u64,
        statements: usize,
    },
    Failed {
        failed_index: usize,
        statements: usize,
        error: String,
    },
}

/// Run statements sequentially inside a single transaction; any failure rolls
/// the whole script back. The returned `result` is the last statement's
/// (matching the editor's "last result wins" display), with `elapsed_ms`
/// covering the full script.
pub async fn execute_script(pool: &DbPool, stmts: &[String]) -> AppResult<ScriptOutcome> {
    if stmts.is_empty() {
        return Err(AppError::msg("empty script"));
    }
    let start = Instant::now();
    match pool {
        DbPool::Redis(_) => Err(AppError::msg(
            "multi-statement scripts are not supported for Redis",
        )),
        DbPool::Sqlite(p) => sqlite_script(p, stmts, start).await,
        DbPool::Postgres(p) => pg_script(p, stmts, start).await,
        DbPool::Mysql(p) => mysql_script(p, stmts, start).await,
    }
}

macro_rules! script_impl {
    ($fn_name:ident, $pool_ty:ty, $decode:ident) => {
        async fn $fn_name(
            pool: &$pool_ty,
            stmts: &[String],
            start: Instant,
        ) -> AppResult<ScriptOutcome> {
            let mut tx = pool.begin().await?;
            let mut total: u64 = 0;
            let mut last: Option<QueryResult> = None;
            for (i, sql) in stmts.iter().enumerate() {
                let one: AppResult<QueryResult> = if is_readonly(sql) || has_returning(sql) {
                    let stmt_start = Instant::now();
                    match fetch_capped(sqlx::query(sql).fetch(&mut *tx)).await {
                        Ok((rows, truncated)) => {
                            let mut out = $decode(rows, stmt_start);
                            out.truncated = truncated;
                            Ok(out)
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    match sqlx::query(sql).execute(&mut *tx).await {
                        Ok(r) => Ok(QueryResult {
                            columns: vec![],
                            rows: vec![],
                            rows_affected: Some(r.rows_affected()),
                            elapsed_ms: 0,
                            truncated: false,
                        }),
                        Err(e) => Err(e.into()),
                    }
                };
                match one {
                    Ok(r) => {
                        if let Some(n) = r.rows_affected {
                            total += n;
                        }
                        last = Some(r);
                    }
                    Err(e) => {
                        let _ = tx.rollback().await;
                        return Ok(ScriptOutcome::Failed {
                            failed_index: i,
                            statements: stmts.len(),
                            error: e.to_string(),
                        });
                    }
                }
            }
            tx.commit().await?;
            let mut result = last.expect("non-empty script always yields a result");
            result.elapsed_ms = start.elapsed().as_millis() as u64;
            Ok(ScriptOutcome::Ok {
                result,
                total_affected: total,
                statements: stmts.len(),
            })
        }
    };
}

script_impl!(sqlite_script, sqlx::SqlitePool, decode_sqlite);
script_impl!(pg_script, sqlx::PgPool, decode_postgres);
script_impl!(mysql_script, sqlx::MySqlPool, decode_mysql);

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

    #[test]
    fn has_returning_survives_pg_escape_strings() {
        // Backslash-escaped quote inside E'...' must not desync the scanner.
        assert!(has_returning(
            r"INSERT INTO t (name) VALUES (E'O\'Brien') RETURNING id"
        ));
        assert!(!has_returning(r"INSERT INTO t (name) VALUES (E'RETURNING')"));
        assert!(!has_returning(r"INSERT INTO t (name) VALUES (E'a\'RETURNING\'b')"));
    }

    #[test]
    fn is_readonly_rejects_data_modifying_ctes() {
        // PG data-modifying CTEs lead with WITH but write.
        assert!(!is_readonly(
            "WITH d AS (DELETE FROM users RETURNING id) SELECT count(*) FROM d"
        ));
        assert!(!is_readonly(
            "with u as (update t set a=1 returning *) select * from u"
        ));
        assert!(!is_readonly(
            "WITH i AS (INSERT INTO t VALUES (1)) SELECT 1"
        ));
        // Plain read-only CTEs still classify as reads.
        assert!(is_readonly("WITH x AS (SELECT 1) SELECT * FROM x"));
        // Words merely *containing* DML keywords, or quoted ones, don't trip it.
        assert!(is_readonly(
            "WITH x AS (SELECT update_time, deleted FROM logs) SELECT * FROM x"
        ));
        assert!(is_readonly(
            "WITH x AS (SELECT * FROM t WHERE action = 'DELETE') SELECT * FROM x"
        ));
    }

    #[test]
    fn is_readonly_rejects_explain_analyze_writes() {
        assert!(!is_readonly("EXPLAIN ANALYZE INSERT INTO t VALUES (1)"));
        assert!(!is_readonly(
            "EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t WHERE id = 1"
        ));
        assert!(!is_readonly("EXPLAIN (ANALYZE true) UPDATE t SET a = 1"));
        // ANALYZE false / plain EXPLAIN only plan — still a read.
        assert!(is_readonly(
            "EXPLAIN (ANALYZE false, FORMAT JSON) INSERT INTO t VALUES (1)"
        ));
        assert!(is_readonly("EXPLAIN INSERT INTO t VALUES (1)"));
        assert!(is_readonly("EXPLAIN QUERY PLAN INSERT INTO t VALUES (1)"));
        assert!(is_readonly("EXPLAIN ANALYZE SELECT 1"));
    }

    #[test]
    fn is_readonly_rejects_select_into() {
        assert!(!is_readonly("SELECT * INTO newtab FROM old"));
        assert!(!is_readonly("select id into tmp from users"));
        assert!(!is_readonly(
            "WITH x AS (SELECT 1 AS a) SELECT * INTO t FROM x"
        ));
        assert!(is_readonly("SELECT * FROM t WHERE action = 'INTO'"));
        assert!(is_readonly("SELECT * FROM t WHERE x IN (1, 2)"));
    }

    #[test]
    fn is_readonly_pragma_setters_are_writes() {
        assert!(is_readonly("PRAGMA table_info(users)"));
        assert!(is_readonly("PRAGMA main.table_xinfo(users)"));
        assert!(is_readonly("PRAGMA foreign_key_list(users)"));
        assert!(is_readonly("PRAGMA quick_check(1)"));
        assert!(is_readonly("PRAGMA journal_mode"));
        assert!(!is_readonly("PRAGMA journal_mode=WAL"));
        assert!(!is_readonly("PRAGMA journal_mode = WAL"));
        assert!(!is_readonly("PRAGMA journal_mode(WAL)"));
        assert!(!is_readonly("PRAGMA foreign_keys=ON"));
        assert!(!is_readonly("PRAGMA foreign_keys(ON)"));
        assert!(!is_readonly("PRAGMA user_version(1)"));
        assert!(!is_readonly("PRAGMA busy_timeout(5000)"));
        assert!(!is_readonly("PRAGMA wal_checkpoint(FULL)"));
        assert!(!is_readonly("PRAGMA optimize"));
    }

    #[test]
    fn scan_bare_words_skips_dollar_quotes() {
        assert!(is_readonly(
            "SELECT $$ DELETE FROM t; INSERT INTO t VALUES (1) $$"
        ));
        assert!(has_returning(
            "INSERT INTO t VALUES ($body$RETURNING$body$) RETURNING id"
        ));
        assert!(!has_returning(
            "INSERT INTO t VALUES ($body$RETURNING$body$)"
        ));
    }
}
