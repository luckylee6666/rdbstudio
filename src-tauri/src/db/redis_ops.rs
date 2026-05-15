//! Redis driver glue: just enough to make rdbstudio's commands work
//! (server_version / list_databases / scan keys / run a single command).
//!
//! The query editor sends a raw Redis command line ("HGETALL session:42")
//! and we render the reply as a 1- or 2-column "table" so the existing
//! DataGrid keeps working without a parallel Redis-only viewer.

use crate::db::exec::{ColumnMeta, QueryResult};
use crate::db::pool::RedisHandle;
use crate::error::{AppError, AppResult};
use crate::model::TreeEntry;
use redis::Value as RVal;
use serde_json::{json, Value as Json};
use std::time::Instant;

const SCAN_PAGE: u32 = 200;
/// Default first-page batch size when callers don't specify one. Tree shows
/// "Load more" to walk further when the cursor is non-zero.
pub const DEFAULT_SCAN_LIMIT: usize = 500;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanPage {
    pub keys: Vec<crate::model::TreeEntry>,
    pub next_cursor: u64,
    pub done: bool,
}

pub async fn server_version(handle: &RedisHandle) -> AppResult<String> {
    let mut conn = handle.conn();
    let info: String = redis::cmd("INFO")
        .arg("server")
        .query_async(&mut conn)
        .await?;
    let v = info
        .lines()
        .find_map(|l| l.strip_prefix("redis_version:"))
        .unwrap_or("?");
    Ok(format!("Redis {}", v.trim()))
}

pub async fn list_databases(_handle: &RedisHandle) -> AppResult<Vec<String>> {
    // P0 scope: each connection is bound to a single DB index at connect time.
    // We surface "db<N>" if we can read it, else fall back to "db0".
    Ok(vec!["db0".into()])
}

pub async fn list_keys(handle: &RedisHandle) -> AppResult<Vec<TreeEntry>> {
    Ok(scan_keys(handle, 0, DEFAULT_SCAN_LIMIT).await?.keys)
}

/// Paginated SCAN with TYPE + PTTL enrichment. Caller drives further reads
/// by passing back `next_cursor` until `done == true`. The actual returned
/// page may exceed `limit` slightly because SCAN's COUNT is advisory.
pub async fn scan_keys(
    handle: &RedisHandle,
    start_cursor: u64,
    limit: usize,
) -> AppResult<ScanPage> {
    let mut conn = handle.conn();
    let mut cursor = start_cursor;
    let mut out: Vec<TreeEntry> = Vec::new();
    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(SCAN_PAGE)
            .query_async(&mut conn)
            .await?;
        for k in batch {
            // TYPE + PTTL per key. Small batch, but two extra round-trips per
            // key adds up — pipeline them so we pay one network hop instead of two.
            let (kind, pttl): (String, i64) = redis::pipe()
                .cmd("TYPE")
                .arg(&k)
                .cmd("PTTL")
                .arg(&k)
                .query_async(&mut conn)
                .await?;
            // PTTL: -1 = no expiration, -2 = key gone (race with SCAN); skip -2.
            if pttl == -2 {
                continue;
            }
            out.push(TreeEntry {
                name: k,
                kind,
                schema: None,
                comment: None,
                ttl_ms: Some(pttl),
            });
        }
        cursor = next;
        if cursor == 0 {
            return Ok(ScanPage { keys: out, next_cursor: 0, done: true });
        }
        if out.len() >= limit {
            return Ok(ScanPage {
                keys: out,
                next_cursor: cursor,
                done: false,
            });
        }
    }
}

pub async fn execute(handle: &RedisHandle, command_line: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let args = parse_args(command_line)?;
    if args.is_empty() {
        return Err(AppError::msg("empty Redis command"));
    }
    let mut cmd = redis::cmd(&args[0]);
    for a in &args[1..] {
        cmd.arg(a.as_str());
    }
    let mut conn = handle.conn();
    let reply: RVal = cmd.query_async(&mut conn).await?;
    Ok(reply_to_table(&args[0], reply, start))
}

fn reply_to_table(cmd_name: &str, v: RVal, start: Instant) -> QueryResult {
    let elapsed = start.elapsed().as_millis() as u64;
    match v {
        // Status / Okay / Nil → single-cell "result" column so the user
        // always sees the verb's outcome instead of a blank table.
        RVal::Okay => single_cell("result", json!("OK"), elapsed),
        RVal::Nil => single_cell("result", Json::Null, elapsed),
        RVal::SimpleString(s) => single_cell("result", json!(s), elapsed),
        RVal::Int(i) => single_cell("result", json!(i), elapsed),
        RVal::BulkString(b) => single_cell("result", bytes_to_json(&b), elapsed),
        RVal::Array(items) => {
            // HGETALL / CONFIG GET return a flat array of [k, v, k, v, …];
            // surface as a key/value table when the command is known to be
            // map-shaped, otherwise as a 1-col positional list.
            if is_map_reply(cmd_name) && items.len() % 2 == 0 {
                let rows: Vec<Vec<Json>> = items
                    .chunks(2)
                    .map(|p| vec![rval_to_json(&p[0]), rval_to_json(&p[1])])
                    .collect();
                QueryResult {
                    columns: vec![
                        ColumnMeta { name: "field".into(), data_type: "redis".into() },
                        ColumnMeta { name: "value".into(), data_type: "redis".into() },
                    ],
                    rows,
                    rows_affected: None,
                    elapsed_ms: elapsed,
                }
            } else {
                let rows: Vec<Vec<Json>> =
                    items.iter().map(|x| vec![rval_to_json(x)]).collect();
                QueryResult {
                    columns: vec![ColumnMeta {
                        name: "value".into(),
                        data_type: "redis".into(),
                    }],
                    rows,
                    rows_affected: None,
                    elapsed_ms: elapsed,
                }
            }
        }
        // Newer redis-rs reply types; render via a single JSON cell.
        other => single_cell("result", rval_to_json(&other), elapsed),
    }
}

fn single_cell(col: &str, v: Json, elapsed_ms: u64) -> QueryResult {
    QueryResult {
        columns: vec![ColumnMeta {
            name: col.into(),
            data_type: "redis".into(),
        }],
        rows: vec![vec![v]],
        rows_affected: None,
        elapsed_ms,
    }
}

fn rval_to_json(v: &RVal) -> Json {
    match v {
        RVal::Nil => Json::Null,
        RVal::Int(i) => json!(i),
        RVal::Okay => json!("OK"),
        RVal::SimpleString(s) => json!(s),
        RVal::BulkString(b) => bytes_to_json(b),
        RVal::Array(items) => Json::Array(items.iter().map(rval_to_json).collect()),
        // Fallback for less-common variants — keep them debuggable.
        other => json!(format!("{:?}", other)),
    }
}

fn bytes_to_json(b: &[u8]) -> Json {
    match std::str::from_utf8(b) {
        Ok(s) => json!(s),
        // Binary blob — base64-ish so it survives JSON transport.
        Err(_) => json!(crate::db::redis_ops::base64_like(b)),
    }
}

fn is_map_reply(cmd: &str) -> bool {
    matches!(
        cmd.to_ascii_uppercase().as_str(),
        "HGETALL" | "CONFIG" | "XRANGE" | "XREVRANGE" | "CLIENT"
    )
}

/// Whitespace-split with simple "double-quoted" literal support so users
/// can paste e.g. `SET greeting "hello world"` without shell-escaping.
fn parse_args(line: &str) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut in_quote = false;
    let mut chars = line.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if !in_quote => in_quote = true,
            '"' if in_quote => {
                in_quote = false;
                out.push(std::mem::take(&mut buf));
            }
            '\\' if in_quote => {
                if let Some(&n) = chars.peek() {
                    chars.next();
                    buf.push(match n {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        '"' => '"',
                        '\\' => '\\',
                        other => other,
                    });
                }
            }
            c if c.is_whitespace() && !in_quote => {
                if !buf.is_empty() {
                    out.push(std::mem::take(&mut buf));
                }
            }
            c => buf.push(c),
        }
    }
    if in_quote {
        return Err(AppError::msg("unterminated quoted argument"));
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    Ok(out)
}

// Tiny base64 helper — pulled in here so we don't take a public dep just
// to print binary Redis values; matches db/exec.rs::base64_like behavior.
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

/// Adapt the SQL-side helpers to gracefully decline on Redis pools.
pub fn unsupported<T>(action: &str) -> AppResult<T> {
    Err(AppError::msg(format!(
        "{} is not supported on Redis connections",
        action
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_splits_on_whitespace() {
        assert_eq!(parse_args("GET foo").unwrap(), vec!["GET", "foo"]);
        assert_eq!(
            parse_args("HSET user:1 name Alice").unwrap(),
            vec!["HSET", "user:1", "name", "Alice"]
        );
    }

    #[test]
    fn parse_args_keeps_quoted_string_intact() {
        assert_eq!(
            parse_args(r#"SET greeting "hello world""#).unwrap(),
            vec!["SET", "greeting", "hello world"]
        );
    }

    #[test]
    fn parse_args_handles_escapes_in_quotes() {
        assert_eq!(
            parse_args(r#"SET note "line1\nline2""#).unwrap(),
            vec!["SET", "note", "line1\nline2"]
        );
    }

    #[test]
    fn parse_args_unterminated_quote_errors() {
        assert!(parse_args(r#"SET k "open"#).is_err());
    }

    #[test]
    fn parse_args_empty_input_returns_empty_vec() {
        assert!(parse_args("").unwrap().is_empty());
        assert!(parse_args("   ").unwrap().is_empty());
    }

    #[test]
    fn reply_to_table_okay_yields_single_ok_cell() {
        let r = reply_to_table("SET", RVal::Okay, Instant::now());
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.rows[0][0].as_str(), Some("OK"));
    }

    #[test]
    fn reply_to_table_int_yields_single_int_cell() {
        let r = reply_to_table("INCR", RVal::Int(7), Instant::now());
        assert_eq!(r.rows[0][0].as_i64(), Some(7));
    }

    #[test]
    fn reply_to_table_hgetall_pivots_to_field_value_table() {
        let arr = RVal::Array(vec![
            RVal::BulkString(b"name".to_vec()),
            RVal::BulkString(b"Alice".to_vec()),
            RVal::BulkString(b"age".to_vec()),
            RVal::BulkString(b"30".to_vec()),
        ]);
        let r = reply_to_table("HGETALL", arr, Instant::now());
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.columns[0].name, "field");
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][0].as_str(), Some("name"));
        assert_eq!(r.rows[1][1].as_str(), Some("30"));
    }

    #[test]
    fn reply_to_table_keys_array_renders_as_one_column() {
        let arr = RVal::Array(vec![
            RVal::BulkString(b"a".to_vec()),
            RVal::BulkString(b"b".to_vec()),
        ]);
        let r = reply_to_table("KEYS", arr, Instant::now());
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.rows.len(), 2);
    }

    #[test]
    fn reply_to_table_nil_yields_null_cell() {
        let r = reply_to_table("GET", RVal::Nil, Instant::now());
        assert!(r.rows[0][0].is_null());
    }
}
