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
        if skip_quoted_or_comment(c, &word, &mut chars).is_some() {
            word.clear();
            continue;
        }
        match c {
            '$' => {
                if !word.is_empty() && pred(&word) {
                    return true;
                }
                word.clear();
                skip_dollar_quote_body(&mut chars);
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

/// What `skip_quoted_or_comment` consumed. The distinction only matters to
/// `is_single_statement`, where a comment after `;` is harmless trailing text
/// while a literal is the start of a second statement.
enum Lexeme {
    Literal,
    Comment,
}

/// Consume a quoted literal/identifier or a comment opening at `c`, returning
/// `None` — with the iterator untouched — when `c` opens neither. `prev_word`
/// carries the pending bare word so Postgres' `E'…'` escape strings honor
/// backslash escapes and `E'O\'Brien'` doesn't desync the literal tracking.
fn skip_quoted_or_comment(
    c: char,
    prev_word: &str,
    chars: &mut std::iter::Peekable<impl Iterator<Item = char>>,
) -> Option<Lexeme> {
    match c {
        '\'' if prev_word == "E" => {
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
            Some(Lexeme::Literal)
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
            Some(Lexeme::Literal)
        }
        '-' if chars.peek() == Some(&'-') => {
            for n in chars.by_ref() {
                if n == '\n' {
                    break;
                }
            }
            Some(Lexeme::Comment)
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
            Some(Lexeme::Comment)
        }
        _ => None,
    }
}

/// Consume a Postgres dollar-quoted string whose opening `$` was just read.
/// `$1` is a bind placeholder, not a quote, and leaves the iterator alone.
fn skip_dollar_quote_body(chars: &mut std::iter::Peekable<impl Iterator<Item = char>>) {
    match chars.peek().copied() {
        Some(c) if c.is_ascii_digit() => {}
        Some('$') => {
            chars.next();
            skip_dollar_quoted(chars, "");
        }
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            let mut tag = String::new();
            while let Some(n) = chars.peek().copied() {
                if n == '$' {
                    chars.next();
                    skip_dollar_quoted(chars, &tag);
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

/// True when `sql` carries at most one statement: only whitespace, comments,
/// or further empty statements follow the first bare `;`.
///
/// MySQL editor SQL is sent unprepared (see `mysql_select`) and one such round
/// trip may carry several statements. `is_readonly` classifies a single one,
/// so a read-only connection has to reject anything trailing before it reaches
/// the driver — otherwise `SELECT 1; DELETE FROM t` would pass as a read.
pub fn is_single_statement(sql: &str) -> bool {
    let mut chars = sql.chars().peekable();
    let mut word = String::new();
    let mut terminated = false;
    while let Some(c) = chars.next() {
        match skip_quoted_or_comment(c, &word, &mut chars) {
            Some(Lexeme::Comment) => {
                word.clear();
                continue;
            }
            Some(Lexeme::Literal) => {
                if terminated {
                    return false;
                }
                word.clear();
                continue;
            }
            None => {}
        }
        match c {
            ';' => {
                terminated = true;
                word.clear();
            }
            c if c.is_whitespace() => word.clear(),
            _ if terminated => return false,
            '$' => {
                word.clear();
                skip_dollar_quote_body(&mut chars);
            }
            c if c.is_alphanumeric() || c == '_' => word.push(c.to_ascii_uppercase()),
            _ => word.clear(),
        }
    }
    true
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

/// Column metadata for a statement that came back with no rows. sqlx builds
/// columns out of the rows themselves, so an empty result set would otherwise
/// reach the grid with no headers at all — `SELECT id, name FROM t WHERE 1 = 0`
/// rendered as a blank rectangle. Costs one extra round trip, and only when
/// there is nothing else to go on. A driver that refuses to describe the
/// statement (MySQL cannot prepare all of them — see `mysql_select`) leaves the
/// result headerless, exactly as before, rather than failing the query.
async fn describe_columns<'e, DB, E>(executor: E, sql: &str) -> Vec<ColumnMeta>
where
    DB: sqlx::Database,
    E: sqlx::Executor<'e, Database = DB>,
{
    match executor.describe(sql).await {
        Ok(described) => described
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                data_type: c.type_info().name().to_string(),
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Decode a driver-specific row stream while keeping MCP's memory/response
/// envelope substantially smaller than the interactive editor's. The stream
/// is scoped inside the macro expansion so its mutable connection borrow ends
/// before the caller issues ROLLBACK.
macro_rules! fetch_mcp_bounded {
    ($stream:expr, $decode:ident, $max_rows:expr, $max_json_bytes:expr) => {{
        async {
            use futures::TryStreamExt;

            let mut stream = $stream;
            let mut columns: Vec<ColumnMeta> = Vec::new();
            let mut rows: Vec<Vec<Json>> = Vec::new();
            let mut used_json_bytes = 0usize;
            let mut truncated = false;

            while let Some(row) = stream.try_next().await? {
                if columns.is_empty() {
                    columns = row
                        .columns()
                        .iter()
                        .map(|column| ColumnMeta {
                            name: column.name().to_string(),
                            data_type: column.type_info().name().to_string(),
                        })
                        .collect();
                }
                if rows.len() >= $max_rows {
                    truncated = true;
                    break;
                }

                let decoded: Vec<Json> = (0..row.columns().len())
                    .map(|index| $decode(&row, index))
                    .collect();
                let row_bytes = serde_json::to_vec(&decoded)?.len();
                if row_bytes > $max_json_bytes.saturating_sub(used_json_bytes) {
                    truncated = true;
                    break;
                }
                used_json_bytes = used_json_bytes.saturating_add(row_bytes + 1);
                rows.push(decoded);
            }

            Ok::<_, AppError>((columns, rows, truncated))
        }
        .await
    }};
}

/// Returns a pooled connection normally only after its read-only/session
/// state has been restored. Cancellation or any early error closes the socket
/// instead, preventing a dirty session from leaking back into the editor pool.
/// Shared by the MCP bridge and the editor's read-only connections.
struct GuardedConnection<DB: sqlx::Database> {
    inner: sqlx::pool::PoolConnection<DB>,
    reusable: bool,
}

impl<DB: sqlx::Database> GuardedConnection<DB> {
    fn new(inner: sqlx::pool::PoolConnection<DB>) -> Self {
        Self {
            inner,
            reusable: false,
        }
    }

    fn mark_reusable(&mut self) {
        self.reusable = true;
    }
}

impl<DB: sqlx::Database> Drop for GuardedConnection<DB> {
    fn drop(&mut self) {
        if !self.reusable {
            self.inner.close_on_drop();
        }
    }
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
            // Text protocol, for the reasons documented on `mysql_select`.
            DbPool::Mysql(p) => sqlx::raw_sql(sql).execute(p).await?.rows_affected(),
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

/// Execute one statement with the database's own read-only mode switched on,
/// for connections the user marked read-only.
///
/// Classifying the SQL (`is_readonly`) is not enough on its own: a `SELECT`
/// that calls a side-effecting function or `nextval()` reads like a read and
/// writes like a write. The MCP bridge has been guarded at the database layer
/// since 0.1.4; this puts the editor's read-only connections behind the same
/// barrier, with the editor's own row cap instead of MCP's byte budget.
pub async fn execute_readonly(pool: &DbPool, sql: &str) -> AppResult<QueryResult> {
    // Redis has no transactional read-only mode; its guard is the command
    // allowlist the caller already applied.
    if let DbPool::Redis(h) = pool {
        return redis_ops::execute(h, sql).await;
    }
    let start = Instant::now();
    match pool {
        DbPool::Redis(_) => unreachable!("handled above"),
        DbPool::Sqlite(pool) => {
            let mut conn = GuardedConnection::new(pool.acquire().await?);
            sqlx::query("PRAGMA query_only = ON")
                .execute(&mut *conn.inner)
                .await?;
            let fetched = fetch_capped(sqlx::query(sql).fetch(&mut *conn.inner)).await;
            let cleanup = sqlx::query("PRAGMA query_only = OFF")
                .execute(&mut *conn.inner)
                .await;
            if cleanup.is_ok() {
                conn.mark_reusable();
            }
            let (rows, truncated) = fetched?;
            cleanup?;
            let mut out = decode_sqlite(rows, start);
            out.truncated = truncated;
            if out.columns.is_empty() {
                out.columns = describe_columns(&mut *conn.inner, sql).await;
            }
            Ok(out)
        }
        DbPool::Postgres(pool) => {
            let mut conn = GuardedConnection::new(pool.acquire().await?);
            sqlx::query("BEGIN READ ONLY")
                .execute(&mut *conn.inner)
                .await?;
            let fetched = fetch_capped(sqlx::query(sql).fetch(&mut *conn.inner)).await;
            let cleanup = sqlx::query("ROLLBACK").execute(&mut *conn.inner).await;
            if cleanup.is_ok() {
                conn.mark_reusable();
            }
            let (rows, truncated) = fetched?;
            cleanup?;
            let mut out = decode_postgres(rows, start);
            out.truncated = truncated;
            if out.columns.is_empty() {
                out.columns = describe_columns(&mut *conn.inner, sql).await;
            }
            Ok(out)
        }
        DbPool::Mysql(pool) => {
            let mut conn = GuardedConnection::new(pool.acquire().await?);
            // Text protocol for the guard itself: MySQL rejects
            // `START TRANSACTION` over the prepared protocol with error 1295,
            // which would fail the query instead of protecting it.
            sqlx::Executor::execute(&mut *conn.inner, "START TRANSACTION READ ONLY").await?;
            // Text protocol too, like every other editor path (see
            // `mysql_select`). A single round trip can carry several
            // statements, which the caller's single-statement check rules out
            // before we get here.
            let fetched = fetch_capped(sqlx::Executor::fetch(&mut *conn.inner, sql)).await;
            let cleanup = sqlx::Executor::execute(&mut *conn.inner, "ROLLBACK").await;
            if cleanup.is_ok() {
                conn.mark_reusable();
            }
            let (rows, truncated) = fetched?;
            cleanup?;
            let mut out = decode_mysql(rows, start);
            out.truncated = truncated;
            if out.columns.is_empty() {
                out.columns = describe_columns(&mut *conn.inner, sql).await;
            }
            Ok(out)
        }
    }
}

/// Run a read-only script statement by statement, each behind the database's
/// own read-only mode. Nothing writes, so there is no transaction to wrap.
pub async fn execute_script_readonly(pool: &DbPool, stmts: &[String]) -> AppResult<ScriptOutcome> {
    if stmts.is_empty() {
        return Err(AppError::msg("empty script"));
    }
    let start = Instant::now();
    let mut last: Option<QueryResult> = None;
    for (i, sql) in stmts.iter().enumerate() {
        match execute_readonly(pool, sql).await {
            Ok(r) => last = Some(r),
            Err(e) => {
                return Ok(ScriptOutcome::Failed {
                    failed_index: i,
                    statements: stmts.len(),
                    error: e.to_string(),
                    // Read-only throughout: nothing could have been left behind.
                    rollback: RollbackState::Complete,
                });
            }
        }
    }
    script_ok(last, 0, stmts.len(), start)
}

/// Execute a single SQL query for the local MCP bridge with two independent
/// safeguards:
///
/// 1. the database connection itself is put in read-only mode, so a SELECT
///    that invokes a side-effecting stored function still cannot mutate data;
/// 2. rows are decoded incrementally under row and JSON byte budgets instead
///    of first buffering the editor's much larger `MAX_ROWS` allowance.
///
/// The caller still performs a fail-closed single-statement syntax check. The
/// database-level guard here is the authoritative write barrier.
pub async fn execute_mcp_readonly(
    pool: &DbPool,
    sql: &str,
    max_rows: usize,
    max_json_bytes: usize,
) -> AppResult<QueryResult> {
    if max_rows == 0 || max_json_bytes == 0 {
        return Err(AppError::msg("MCP query result limits must be positive"));
    }

    let start = Instant::now();
    let (columns, rows, truncated) = match pool {
        DbPool::Redis(_) => {
            return Err(AppError::msg(
                "SQL read-only execution is not available for Redis",
            ))
        }
        DbPool::Sqlite(pool) => {
            // query_only is connection-local. close_on_drop is essential: if
            // this future is cancelled or times out, the connection must not
            // return to the shared editor pool with query_only still enabled.
            let mut conn = GuardedConnection::new(pool.acquire().await?);
            sqlx::query("PRAGMA query_only = ON")
                .execute(&mut *conn.inner)
                .await?;
            let result = fetch_mcp_bounded!(
                sqlx::query(sql).fetch(&mut *conn.inner),
                sqlite_val,
                max_rows,
                max_json_bytes
            );
            let cleanup = sqlx::query("PRAGMA query_only = OFF")
                .execute(&mut *conn.inner)
                .await;
            if cleanup.is_ok() {
                conn.mark_reusable();
            }
            let result = result?;
            cleanup?;
            result
        }
        DbPool::Postgres(pool) => {
            let mut conn = GuardedConnection::new(pool.acquire().await?);
            sqlx::query("BEGIN READ ONLY")
                .execute(&mut *conn.inner)
                .await?;
            let result = fetch_mcp_bounded!(
                sqlx::query(sql).fetch(&mut *conn.inner),
                pg_val,
                max_rows,
                max_json_bytes
            );
            let cleanup = sqlx::query("ROLLBACK").execute(&mut *conn.inner).await;
            if cleanup.is_ok() {
                conn.mark_reusable();
            }
            let result = result?;
            cleanup?;
            result
        }
        DbPool::Mysql(pool) => {
            let mut conn = GuardedConnection::new(pool.acquire().await?);
            // The guard has to travel over the text protocol: MySQL refuses
            // `START TRANSACTION` in the prepared protocol (error 1295), so
            // preparing it failed every MySQL query this bridge ever ran.
            // The query below deliberately stays prepared — that is what keeps
            // a second statement from riding along in the same round trip.
            sqlx::Executor::execute(&mut *conn.inner, "START TRANSACTION READ ONLY").await?;
            let result = fetch_mcp_bounded!(
                sqlx::query(sql).fetch(&mut *conn.inner),
                mysql_val,
                max_rows,
                max_json_bytes
            );
            let cleanup = sqlx::Executor::execute(&mut *conn.inner, "ROLLBACK").await;
            if cleanup.is_ok() {
                conn.mark_reusable();
            }
            let result = result?;
            cleanup?;
            result
        }
    };

    Ok(QueryResult {
        columns,
        rows,
        rows_affected: None,
        elapsed_ms: start.elapsed().as_millis() as u64,
        truncated,
    })
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
        rollback: RollbackState,
    },
}

/// What survived a failed script.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RollbackState {
    /// Everything the script ran was undone.
    Complete,
    /// The server kept part of it: MySQL commits DDL implicitly, so a script
    /// that altered a table before failing leaves that change behind.
    Partial,
    /// The script drives its own `BEGIN` / `COMMIT`, so nothing was rolled
    /// back on its behalf — what stands is whatever the user's own
    /// transaction statements committed.
    SelfManaged,
}

/// True when a MySQL statement leaves the surrounding transaction intact.
///
/// This is an allowlist on purpose. MySQL's implicit-commit set is long and
/// version-dependent (all DDL, account management, `LOCK TABLES`, `FLUSH`,
/// `ANALYZE`/`OPTIMIZE`/`REPAIR TABLE`, …), and a statement we fail to
/// recognise must not be allowed to claim a clean rollback. `EXECUTE` and
/// `CALL` are excluded for the same reason: what they run is only known at
/// runtime, and the conditional-DDL idiom (`PREPARE stmt FROM @ddl; EXECUTE
/// stmt`) hides an `ALTER TABLE` behind a user variable — exactly the case
/// worth warning about.
fn mysql_keeps_transaction(sql: &str) -> bool {
    match first_keyword(sql).as_str() {
        // Session and user variables are fine; `SET autocommit` and
        // `SET PASSWORD` commit.
        "SET" => {
            let rest = skip_first_keyword(sql).trim_start().to_ascii_uppercase();
            !rest.starts_with("PASSWORD") && !rest.starts_with("AUTOCOMMIT")
        }
        "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "WITH" | "VALUES" | "TABLE"
        | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PREPARE" | "DEALLOCATE" | "DO" | "USE"
        | "SAVEPOINT" | "HANDLER" | "HELP" => true,
        _ => false,
    }
}

/// Whether rolling back the statements that ran (`ran` ends with the one that
/// failed — MySQL's implicit commit happens *before* a statement executes, so
/// a failing DDL still committed everything before it) undoes all of them.
fn mysql_rollback_state(ran: &[String]) -> RollbackState {
    if ran.iter().all(|s| mysql_keeps_transaction(s)) {
        RollbackState::Complete
    } else {
        RollbackState::Partial
    }
}

/// SQLite and Postgres are transactional for DDL too: a rollback is total.
fn rollback_always_complete(_ran: &[String]) -> RollbackState {
    RollbackState::Complete
}

/// A self-managed batch borrows one connection for the whole run and then
/// throws it away instead of returning it to the pool. `USE`, `SET`, temp
/// tables, prepared statement names and — worst of all — a transaction the
/// script opened but never closed all live on the connection; handing it back
/// would leak that state into whatever query picks it up next.
fn close_after_batch<DB: sqlx::Database>(mut conn: sqlx::pool::PoolConnection<DB>) {
    conn.close_on_drop();
}

/// SQLite keeps its connection: session state there is limited to `PRAGMA`,
/// and closing would destroy an in-memory database outright.
fn reuse_after_batch<DB: sqlx::Database>(_conn: sqlx::pool::PoolConnection<DB>) {}

/// A self-managed batch can end with the script's transaction still open (the
/// script failed mid-way, or simply never committed). For the drivers that
/// close the connection this is moot, but SQLite hands the connection back —
/// and a pooled connection with an open transaction poisons every statement
/// that picks it up next (including a later `BEGIN`, which then errors with
/// "cannot start a transaction within a transaction").
async fn sqlite_end_transaction(conn: &mut sqlx::pool::PoolConnection<sqlx::Sqlite>) {
    let _ = sqlx::query("ROLLBACK").execute(&mut **conn).await;
}

async fn noop_cleanup<DB: sqlx::Database>(_conn: &mut sqlx::pool::PoolConnection<DB>) {}

/// Run statements sequentially on **one** connection. `atomic` wraps them in a
/// transaction so any failure rolls the whole script back; a script that
/// drives its own `BEGIN` / `COMMIT` passes `atomic = false` and gets the bare
/// connection instead — running those statement by statement over a shared
/// pool used to scatter them across connections, which silently turned the
/// user's `ROLLBACK` into a no-op over an already autocommitted write.
///
/// The returned `result` is the last statement's (matching the editor's "last
/// result wins" display), with `elapsed_ms` covering the full script.
pub async fn execute_script(
    pool: &DbPool,
    stmts: &[String],
    atomic: bool,
) -> AppResult<ScriptOutcome> {
    if stmts.is_empty() {
        return Err(AppError::msg("empty script"));
    }
    let start = Instant::now();
    match pool {
        DbPool::Redis(_) => Err(AppError::msg(
            "multi-statement scripts are not supported for Redis",
        )),
        DbPool::Sqlite(p) => sqlite_script(p, stmts, start, atomic).await,
        DbPool::Postgres(p) => pg_script(p, stmts, start, atomic).await,
        DbPool::Mysql(p) => mysql_script(p, stmts, start, atomic).await,
    }
}

/// Shared tail of both script paths: the last statement's result carries the
/// whole run's elapsed time.
fn script_ok(
    last: Option<QueryResult>,
    total: u64,
    statements: usize,
    start: Instant,
) -> AppResult<ScriptOutcome> {
    let mut result = last.expect("non-empty script always yields a result");
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(ScriptOutcome::Ok {
        result,
        total_affected: total,
        statements,
    })
}

/// Drive `$stmts` over one connection handle, stopping at the first failure.
/// Expands inline (it awaits) so the transactional and the self-managed path
/// can share the loop while each holds its own kind of handle.
macro_rules! run_statements {
    ($holder:expr, $stmts:expr, $decode:ident, $proto:ident) => {{
        let mut total: u64 = 0;
        let mut last: Option<QueryResult> = None;
        let mut failure: Option<(usize, String)> = None;
        for (i, sql) in $stmts.iter().enumerate() {
            let one: AppResult<QueryResult> = if is_readonly(sql) || has_returning(sql) {
                let stmt_start = Instant::now();
                match fetch_capped(script_fetch!($proto, &mut *$holder, sql)).await {
                    Ok((rows, truncated)) => {
                        let mut out = $decode(rows, stmt_start);
                        out.truncated = truncated;
                        if out.columns.is_empty() {
                            out.columns = describe_columns(&mut *$holder, sql).await;
                        }
                        Ok(out)
                    }
                    Err(e) => Err(e),
                }
            } else {
                match script_execute!($proto, &mut *$holder, sql).await {
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
                    failure = Some((i, e.to_string()));
                    break;
                }
            }
        }
        (last, total, failure)
    }};
}

/// Per-driver statement dispatch inside a script transaction. `prepared` is
/// the default (`sqlx::query`); `text` hands the executor a bare `&str`, which
/// sqlx sends unprepared — see `mysql_select` for why MySQL needs that.
macro_rules! script_fetch {
    (prepared, $tx:expr, $sql:expr) => {
        sqlx::query($sql.as_str()).fetch($tx)
    };
    (text, $tx:expr, $sql:expr) => {
        sqlx::Executor::fetch($tx, $sql.as_str())
    };
}

macro_rules! script_execute {
    (prepared, $tx:expr, $sql:expr) => {
        sqlx::query($sql.as_str()).execute($tx)
    };
    (text, $tx:expr, $sql:expr) => {
        sqlx::Executor::execute($tx, $sql.as_str())
    };
}

macro_rules! script_impl {
    ($fn_name:ident, $pool_ty:ty, $decode:ident, $proto:ident, $rollback:path, $release:path, $cleanup:path) => {
        async fn $fn_name(
            pool: &$pool_ty,
            stmts: &[String],
            start: Instant,
            atomic: bool,
        ) -> AppResult<ScriptOutcome> {
            if atomic {
                let mut tx = pool.begin().await?;
                let (last, total, failure) = run_statements!(tx, stmts, $decode, $proto);
                if let Some((i, error)) = failure {
                    let _ = tx.rollback().await;
                    return Ok(ScriptOutcome::Failed {
                        failed_index: i,
                        statements: stmts.len(),
                        error,
                        rollback: $rollback(&stmts[..=i]),
                    });
                }
                tx.commit().await?;
                script_ok(last, total, stmts.len(), start)
            } else {
                // The script's own BEGIN/COMMIT only mean anything if every
                // statement lands on the same connection.
                let mut conn = pool.acquire().await?;
                let (last, total, failure) = run_statements!(conn, stmts, $decode, $proto);
                $cleanup(&mut conn).await;
                $release(conn);
                if let Some((i, error)) = failure {
                    return Ok(ScriptOutcome::Failed {
                        failed_index: i,
                        statements: stmts.len(),
                        error,
                        rollback: RollbackState::SelfManaged,
                    });
                }
                script_ok(last, total, stmts.len(), start)
            }
        }
    };
}

script_impl!(
    sqlite_script,
    sqlx::SqlitePool,
    decode_sqlite,
    prepared,
    rollback_always_complete,
    reuse_after_batch,
    sqlite_end_transaction
);
script_impl!(
    pg_script,
    sqlx::PgPool,
    decode_postgres,
    prepared,
    rollback_always_complete,
    close_after_batch,
    noop_cleanup
);
script_impl!(
    mysql_script,
    sqlx::MySqlPool,
    decode_mysql,
    text,
    mysql_rollback_state,
    close_after_batch,
    noop_cleanup
);

async fn sqlite_select(
    pool: &sqlx::SqlitePool,
    sql: &str,
    start: Instant,
) -> AppResult<QueryResult> {
    let (rows, truncated) = fetch_capped(sqlx::query(sql).fetch(pool)).await?;
    let mut out = decode_sqlite(rows, start);
    out.truncated = truncated;
    if out.columns.is_empty() {
        out.columns = describe_columns(pool, sql).await;
    }
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
    if out.columns.is_empty() {
        out.columns = describe_columns(pool, sql).await;
    }
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
        // DATE / TIME are their own binary encodings; decoding them through
        // `NaiveDateTime` fails silently and the column used to render NULL.
        "DATE" => try_naive_date(r, i).unwrap_or(Json::Null),
        "TIME" => try_naive_time(r, i).unwrap_or(Json::Null),
        "TIMESTAMP" => try_naive_datetime(r, i).unwrap_or(Json::Null),
        "TIMESTAMPTZ" => try_datetime_utc(r, i).unwrap_or(Json::Null),
        // TIMETZ has no sqlx decoder; keep the string fallback and accept NULL.
        "TIMETZ" => try_str(r, i).unwrap_or(Json::Null),
        "BYTEA" => try_bytes_b64(r, i).unwrap_or(Json::Null),
        // sqlx only decodes NUMERIC/DECIMAL through `Decimal` (rust_decimal
        // feature); UUID and text fallbacks above never match binary numerics.
        "NUMERIC" | "DECIMAL" => try_decimal(r, i).unwrap_or(Json::Null),
        "MONEY" => r
            .try_get::<Option<i64>, _>(i)
            .ok()
            .flatten()
            .map(|cents| Json::String(money_str(cents)))
            .unwrap_or(Json::Null),
        arr if arr.ends_with("[]") => pg_array_val(r, i, arr),
        _ => try_str(r, i)
            .or_else(|| try_i64(r, i))
            .or_else(|| try_f64(r, i))
            .unwrap_or(Json::Null),
    }
}

/// Postgres arrays arrive as `TYPE[]` result columns. Render common element
/// types as a JSON array; anything else stays NULL rather than mojibake.
fn pg_array_val(r: &sqlx::postgres::PgRow, i: usize, ty: &str) -> Json {
    let base = ty.trim_end_matches("[]");
    let array: Option<Json> = match base {
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "CITEXT" => {
            r.try_get::<Option<Vec<String>>, _>(i).ok().flatten().map(|v| {
                Json::Array(v.into_iter().map(Json::String).collect())
            })
        }
        "INT2" => r
            .try_get::<Option<Vec<i16>>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::Array(v.into_iter().map(Json::from).collect())),
        "INT4" => r
            .try_get::<Option<Vec<i32>>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::Array(v.into_iter().map(Json::from).collect())),
        "INT8" => r.try_get::<Option<Vec<i64>>, _>(i).ok().flatten().map(|v| {
            Json::Array(v.into_iter().map(json_i64).collect())
        }),
        "BOOL" => r
            .try_get::<Option<Vec<bool>>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::Array(v.into_iter().map(Json::Bool).collect())),
        "FLOAT4" => r.try_get::<Option<Vec<f32>>, _>(i).ok().flatten().map(|v| {
            Json::Array(
                v.into_iter()
                    .map(|x| json_f64(x as f64))
                    .collect(),
            )
        }),
        "FLOAT8" => r.try_get::<Option<Vec<f64>>, _>(i).ok().flatten().map(|v| {
            Json::Array(v.into_iter().map(json_f64).collect())
        }),
        "UUID" => r.try_get::<Option<Vec<sqlx::types::Uuid>>, _>(i).ok().flatten().map(
            |v| Json::Array(v.into_iter().map(|x| Json::String(x.to_string())).collect()),
        ),
        "NUMERIC" | "DECIMAL" => r
            .try_get::<Option<Vec<sqlx::types::Decimal>>, _>(i)
            .ok()
            .flatten()
            .map(|v| {
                Json::Array(
                    v.into_iter()
                        .map(|x| Json::String(x.to_string()))
                        .collect(),
                )
            }),
        _ => None,
    };
    array.unwrap_or(Json::Null)
}

/// `money` is an int64 of cents (locale-dependent scale is ignored).
fn money_str(cents: i64) -> String {
    let abs = cents.unsigned_abs();
    format!(
        "{}{}.{:02}",
        if cents < 0 { "-" } else { "" },
        abs / 100,
        abs % 100
    )
}


/// Editor SQL reaches MySQL over the text protocol (`raw_sql`), not the
/// prepared-statement protocol `sqlx::query` uses. MySQL refuses a whole class
/// of statements once they are prepared — `PREPARE` / `EXECUTE` / `DEALLOCATE
/// PREPARE`, `USE`, `LOCK TABLES`, `LOAD DATA`, some `SHOW` variants — with
/// error 1295 ("This command is not supported in the prepared statement
/// protocol yet"), and hand-written migration scripts routinely use them. The
/// editor never binds parameters, so preparing buys nothing here.
///
/// `execute_mcp_readonly` deliberately stays on `sqlx::query`: the prepared
/// protocol rejects multi-statement input, which is one of the bridge's write
/// barriers.
async fn mysql_select(
    pool: &sqlx::MySqlPool,
    sql: &str,
    start: Instant,
) -> AppResult<QueryResult> {
    let (rows, truncated) = fetch_capped(sqlx::raw_sql(sql).fetch(pool)).await?;
    let mut out = decode_mysql(rows, start);
    out.truncated = truncated;
    if out.columns.is_empty() {
        out.columns = describe_columns(pool, sql).await;
    }
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
        "BOOLEAN" | "BOOL" => try_bool(r, i)
            .or_else(|| try_mysql_i64(r, i))
            .unwrap_or(Json::Null),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => {
            try_mysql_i64(r, i).unwrap_or(Json::Null)
        }
        ty if mysql_uses_u64(ty) => try_u64(r, i).unwrap_or(Json::Null),
        "FLOAT" | "DOUBLE" => try_f64(r, i).unwrap_or(Json::Null),
        "DECIMAL" | "NUMERIC" => {
            try_decimal(r, i).or_else(|| try_f64(r, i)).unwrap_or(Json::Null)
        }
        "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM"
        | "SET" => try_str(r, i).unwrap_or(Json::Null),
        // Each temporal type has its own decoder: DATE/TIME through
        // `NaiveDateTime` silently produced NULL, and TIMESTAMP is not
        // compatible with it either (sqlx maps `NaiveDateTime` to DATETIME).
        "DATE" => try_naive_date(r, i).unwrap_or(Json::Null),
        "TIME" => try_naive_time(r, i).unwrap_or(Json::Null),
        "DATETIME" => try_naive_datetime(r, i).unwrap_or(Json::Null),
        "TIMESTAMP" => r
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)
            .ok()
            .flatten()
            .map(|v| Json::String(v.naive_utc().to_string()))
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
            .or_else(|| try_mysql_i64(r, i))
            .or_else(|| try_f64(r, i))
            .unwrap_or(Json::Null),
    }
}

fn mysql_uses_u64(ty: &str) -> bool {
    matches!(
        ty,
        "TINYINT UNSIGNED"
            | "SMALLINT UNSIGNED"
            | "MEDIUMINT UNSIGNED"
            | "INT UNSIGNED"
            | "INTEGER UNSIGNED"
            | "BIGINT UNSIGNED"
            | "YEAR"
            | "BIT"
    )
}

fn try_i64<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    i64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<i64>, _>(i)
        .ok()
        .flatten()
        .map(json_i64)
}

fn json_f64(v: f64) -> Json {
    serde_json::Number::from_f64(v).map(Json::Number).unwrap_or(Json::Null)
}

fn try_naive_date<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    chrono::NaiveDate: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<chrono::NaiveDate>, _>(i)
        .ok()
        .flatten()
        .map(|v| Json::String(v.to_string()))
}

fn try_naive_time<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    chrono::NaiveTime: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<chrono::NaiveTime>, _>(i)
        .ok()
        .flatten()
        .map(|v| Json::String(v.to_string()))
}

fn try_naive_datetime<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    chrono::NaiveDateTime: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<chrono::NaiveDateTime>, _>(i)
        .ok()
        .flatten()
        .map(|v| Json::String(v.to_string()))
}

fn try_datetime_utc<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    chrono::DateTime<chrono::Utc>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)
        .ok()
        .flatten()
        .map(|v| Json::String(v.to_rfc3339()))
}

/// `numeric` / `decimal` decode through rust_decimal so the exact value
/// survives; JSON gets it as a string, matching the big-integer convention.
fn try_decimal<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    sqlx::types::Decimal: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<sqlx::types::Decimal>, _>(i)
        .ok()
        .flatten()
        .map(|v| Json::String(v.to_string()))
}

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// JSON numbers become IEEE-754 doubles in the webview. Preserve large MySQL
/// integers as decimal strings instead of silently rounding IDs.
fn json_u64(v: u64) -> Json {
    if v <= JS_MAX_SAFE_INTEGER {
        Json::from(v)
    } else {
        Json::String(v.to_string())
    }
}

fn json_i64(v: i64) -> Json {
    let max = JS_MAX_SAFE_INTEGER as i64;
    if (-max..=max).contains(&v) {
        Json::from(v)
    } else {
        Json::String(v.to_string())
    }
}

fn try_mysql_i64(r: &sqlx::mysql::MySqlRow, i: usize) -> Option<Json> {
    r.try_get::<Option<i64>, _>(i)
        .ok()
        .flatten()
        .map(json_i64)
}

fn try_u64<'r, R: Row>(r: &'r R, i: usize) -> Option<Json>
where
    u64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    r.try_get::<Option<u64>, _>(i)
        .ok()
        .flatten()
        .map(json_u64)
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
    fn mysql_rollback_survives_dml_and_session_state() {
        for sql in [
            "SELECT 1",
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "REPLACE INTO t VALUES (1)",
            "SET @ddl := 'ALTER TABLE t ADD COLUMN a INT'",
            "PREPARE s FROM @ddl",
            "DEALLOCATE PREPARE s",
            "SHOW COLUMNS FROM t",
            "-- note\nSELECT 1",
        ] {
            assert!(
                mysql_keeps_transaction(sql),
                "expected rollbackable: {sql:?}"
            );
        }
    }

    #[test]
    fn mysql_rollback_cannot_undo_ddl_or_dynamic_statements() {
        for sql in [
            "ALTER TABLE t ADD COLUMN a INT",
            "CREATE INDEX i ON t (a)",
            "DROP TABLE t",
            "TRUNCATE TABLE t",
            "RENAME TABLE t TO u",
            "LOCK TABLES t WRITE",
            "FLUSH TABLES",
            "GRANT SELECT ON *.* TO u",
            "SET autocommit = 1",
            "SET PASSWORD FOR u = 'x'",
            // Opaque: what these run is only known at runtime.
            "EXECUTE add_column_stmt",
            "CALL do_migration()",
            "TOTALLY UNKNOWN STATEMENT",
        ] {
            assert!(
                !mysql_keeps_transaction(sql),
                "expected implicit commit: {sql:?}"
            );
        }
    }

    #[test]
    fn mysql_rollback_complete_judges_every_statement_that_ran() {
        let dml = ["SET @n := 1".to_string(), "UPDATE t SET a = 1".to_string()];
        assert!(matches!(
            mysql_rollback_state(&dml),
            RollbackState::Complete
        ));

        // The conditional-DDL idiom: the ALTER hides inside @ddl, so the
        // EXECUTE is what marks the script as no longer rollbackable.
        let conditional = [
            "SET @ddl := 'ALTER TABLE t ADD COLUMN a INT'".to_string(),
            "PREPARE s FROM @ddl".to_string(),
            "EXECUTE s".to_string(),
        ];
        assert!(matches!(
            mysql_rollback_state(&conditional),
            RollbackState::Partial
        ));

        assert!(matches!(
            rollback_always_complete(&conditional),
            RollbackState::Complete
        ));
    }

    #[test]
    fn single_statement_accepts_one_statement_with_trailing_noise() {
        for sql in [
            "SELECT 1",
            "SELECT 1;",
            "SELECT 1;   \n\n",
            "SELECT 1;;;",
            "SELECT 1; -- trailing note",
            "SELECT 1; /* trailing note */",
            "-- leading note\nSELECT 1;",
        ] {
            assert!(is_single_statement(sql), "expected single: {sql:?}");
        }
    }

    #[test]
    fn single_statement_ignores_semicolons_inside_literals_and_comments() {
        for sql in [
            "SELECT 'a;b' FROM t",
            "SELECT \"a;b\" FROM t",
            "SELECT `a;b` FROM t",
            "SELECT 1 -- a;b\n",
            "SELECT 1 /* a;b */",
            "SELECT $$a;b$$",
            "SELECT $tag$a;b$tag$",
            "SELECT E'it\\';s' FROM t",
        ] {
            assert!(is_single_statement(sql), "expected single: {sql:?}");
        }
    }

    #[test]
    fn single_statement_rejects_a_trailing_statement() {
        // MySQL sends editor SQL unprepared, so without this the read-only
        // guard would classify `SELECT 1` and let the DELETE through.
        for sql in [
            "SELECT 1; DELETE FROM t",
            "SELECT 1;\nDELETE FROM t;",
            "SELECT 1; -- note\nDELETE FROM t",
            "SELECT 1; 'orphan literal'",
            "SELECT 1;; DROP TABLE t",
        ] {
            assert!(!is_single_statement(sql), "expected multiple: {sql:?}");
        }
    }

    #[test]
    fn mysql_unsigned_values_keep_javascript_safe_numbers_numeric() {
        assert_eq!(json_u64(0), Json::from(0));
        assert_eq!(
            json_u64(JS_MAX_SAFE_INTEGER),
            Json::from(JS_MAX_SAFE_INTEGER)
        );
    }

    #[test]
    fn mysql_unsigned_values_above_javascript_safe_range_stay_exact() {
        assert_eq!(
            json_u64(JS_MAX_SAFE_INTEGER + 1),
            Json::String("9007199254740992".into())
        );
        assert_eq!(
            json_u64(u64::MAX),
            Json::String("18446744073709551615".into())
        );
    }

    #[test]
    fn mysql_signed_values_outside_javascript_safe_range_stay_exact() {
        let max = JS_MAX_SAFE_INTEGER as i64;
        assert_eq!(json_i64(max), Json::from(max));
        assert_eq!(json_i64(-max), Json::from(-max));
        assert_eq!(
            json_i64(max + 1),
            Json::String("9007199254740992".into())
        );
        assert_eq!(
            json_i64(-max - 1),
            Json::String("-9007199254740992".into())
        );
        assert_eq!(json_i64(i64::MAX), Json::String(i64::MAX.to_string()));
        assert_eq!(json_i64(i64::MIN), Json::String(i64::MIN.to_string()));
    }

    #[test]
    fn mysql_unsigned_integer_types_use_u64_decoder() {
        for ty in [
            "TINYINT UNSIGNED",
            "SMALLINT UNSIGNED",
            "MEDIUMINT UNSIGNED",
            "INT UNSIGNED",
            "INTEGER UNSIGNED",
            "BIGINT UNSIGNED",
            "YEAR",
            "BIT",
        ] {
            assert!(mysql_uses_u64(ty), "{ty}");
        }
        assert!(!mysql_uses_u64("BIGINT"));
        assert!(!mysql_uses_u64("BOOLEAN"));
    }

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
