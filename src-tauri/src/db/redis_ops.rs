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
pub const MAX_SCAN_LIMIT: usize = 1_000;

fn bounded_scan_limit(limit: usize) -> usize {
    limit.clamp(1, MAX_SCAN_LIMIT)
}

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

pub async fn list_databases(handle: &RedisHandle) -> AppResult<Vec<String>> {
    // Each connection is bound to a single DB index at connect time.
    Ok(vec![format!("db{}", handle.db_index)])
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
    let limit = bounded_scan_limit(limit);
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

/// Atomic member/field rename with existence guards, via a server-side Lua
/// script. The naive delete-then-add pair could silently clobber an existing
/// target, or lose the value if the source vanished between the two commands.
pub async fn rename_member(
    handle: &RedisHandle,
    key: &str,
    kind: &str,
    old: &str,
    new: &str,
) -> AppResult<()> {
    if old == new {
        return Ok(());
    }
    let lua = match kind {
        "hash" => {
            r#"if redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then
  return redis.error_reply('target field already exists')
end
local v = redis.call('HGET', KEYS[1], ARGV[1])
if v == false then
  return redis.error_reply('source field no longer exists')
end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[1], ARGV[2], v)
return 1"#
        }
        "set" => {
            r#"if redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 1 then
  return redis.error_reply('target member already exists')
end
if redis.call('SREM', KEYS[1], ARGV[1]) == 0 then
  return redis.error_reply('source member no longer exists')
end
redis.call('SADD', KEYS[1], ARGV[2])
return 1"#
        }
        "zset" => {
            r#"if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  return redis.error_reply('target member already exists')
end
local s = redis.call('ZSCORE', KEYS[1], ARGV[1])
if s == false then
  return redis.error_reply('source member no longer exists')
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], s, ARGV[2])
return 1"#
        }
        other => {
            return Err(AppError::msg(format!(
                "rename is not supported for Redis type {other}"
            )))
        }
    };
    let mut conn = handle.conn();
    let _: i64 = redis::Script::new(lua)
        .key(key)
        .arg(old)
        .arg(new)
        .invoke_async(&mut conn)
        .await?;
    Ok(())
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
    Ok(reply_to_table(&args, reply, start))
}

fn reply_to_table(args: &[String], v: RVal, start: Instant) -> QueryResult {
    let cmd_name = args.first().map(|s| s.as_str()).unwrap_or("");
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
            if is_stream_reply(cmd_name) {
                return stream_to_table(items, elapsed);
            }
            // HGETALL / CONFIG GET return a flat array of [k, v, k, v, …];
            // surface as a key/value table when the command is known to be
            // map-shaped, otherwise as a 1-col positional list.
            if is_map_reply(cmd_name, args) && items.len() % 2 == 0 {
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
                    truncated: false,
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
                    truncated: false,
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
        truncated: false,
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

fn is_map_reply(cmd: &str, args: &[String]) -> bool {
    let cmd_upper = cmd.to_ascii_uppercase();
    let cmd_str = cmd_upper.as_str();
    if cmd_str == "ZRANGE" || cmd_str == "ZREVRANGE" {
        args.iter().any(|a| a.eq_ignore_ascii_case("WITHSCORES"))
    } else {
        matches!(cmd_str, "HGETALL" | "CONFIG" | "CLIENT")
    }
}

fn is_stream_reply(cmd: &str) -> bool {
    matches!(
        cmd.to_ascii_uppercase().as_str(),
        "XRANGE" | "XREVRANGE"
    )
}

/// XRANGE returns `[[id, [f, v, …]], …]` — not a flat k/v map. Flatten to
/// `id | fields` so the grid doesn't pair neighbouring entries as field/value.
fn stream_to_table(items: Vec<RVal>, elapsed: u64) -> QueryResult {
    let mut rows = Vec::new();
    for item in items {
        match item {
            RVal::Array(pair) if pair.len() >= 2 => {
                let id = rval_to_json(&pair[0]);
                let fields = match &pair[1] {
                    RVal::Array(kv) => {
                        let mut obj = serde_json::Map::new();
                        for chunk in kv.chunks(2) {
                            if chunk.len() < 2 {
                                continue;
                            }
                            let k = match &chunk[0] {
                                RVal::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
                                RVal::SimpleString(s) => s.clone(),
                                other => format!("{other:?}"),
                            };
                            obj.insert(k, rval_to_json(&chunk[1]));
                        }
                        Json::Object(obj)
                    }
                    other => rval_to_json(other),
                };
                rows.push(vec![id, fields]);
            }
            other => rows.push(vec![rval_to_json(&other), Json::Null]),
        }
    }
    QueryResult {
        columns: vec![
            ColumnMeta {
                name: "id".into(),
                data_type: "redis".into(),
            },
            ColumnMeta {
                name: "fields".into(),
                data_type: "json".into(),
            },
        ],
        rows,
        rows_affected: None,
        elapsed_ms: elapsed,
        truncated: false,
    }
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

/// Adapt the SQL-side helpers to gracefully decline on Redis pools.
pub fn unsupported<T>(action: &str) -> AppResult<T> {
    Err(AppError::msg(format!(
        "{} is not supported on Redis connections",
        action
    )))
}

/// True when a raw editor command line is a read-only Redis command. Used by
/// the connection-level read-only guard. Unknown or unparsable commands are
/// treated as writes — deny by default.
pub fn line_is_readonly(line: &str) -> bool {
    let args = match parse_args(line) {
        Ok(a) => a,
        Err(_) => return false,
    };
    let Some(cmd) = args.first() else {
        return false;
    };
    match cmd.to_uppercase().as_str() {
        // strings / generic
        "GET" | "MGET" | "GETRANGE" | "STRLEN" | "EXISTS" | "TYPE" | "TTL" | "PTTL"
        | "SCAN" | "KEYS" | "RANDOMKEY" | "DBSIZE" | "DUMP" | "OBJECT"
        // hash
        | "HGET" | "HGETALL" | "HMGET" | "HLEN" | "HKEYS" | "HVALS" | "HSCAN" | "HEXISTS"
        | "HSTRLEN" | "HRANDFIELD"
        // list
        | "LRANGE" | "LLEN" | "LINDEX" | "LPOS"
        // set
        | "SMEMBERS" | "SCARD" | "SISMEMBER" | "SMISMEMBER" | "SSCAN" | "SRANDMEMBER"
        // sorted set
        | "ZRANGE" | "ZRANGEBYSCORE" | "ZRANGEBYLEX" | "ZREVRANGE" | "ZCARD" | "ZCOUNT"
        | "ZSCORE" | "ZMSCORE" | "ZRANK" | "ZREVRANK" | "ZSCAN" | "ZRANDMEMBER"
        // stream
        | "XRANGE" | "XREVRANGE" | "XLEN" | "XINFO" | "XREAD"
        // bit / hll
        | "BITCOUNT" | "BITPOS" | "GETBIT" | "PFCOUNT"
        // server / introspection
        | "INFO" | "PING" | "ECHO" | "TIME" | "COMMAND" | "LASTSAVE"
        // RedisJSON reads
        | "JSON.GET" | "JSON.MGET" | "JSON.TYPE" | "JSON.STRLEN" | "JSON.ARRLEN"
        | "JSON.OBJKEYS" | "JSON.OBJLEN" => true,
        // Mixed-mode commands: only their read subcommands pass.
        "CONFIG" => matches!(
            args.get(1).map(|s| s.to_uppercase()).as_deref(),
            Some("GET")
        ),
        "CLIENT" => matches!(
            args.get(1).map(|s| s.to_uppercase()).as_deref(),
            Some("LIST") | Some("INFO") | Some("GETNAME") | Some("ID")
        ),
        "MEMORY" => matches!(
            args.get(1).map(|s| s.to_uppercase()).as_deref(),
            Some("USAGE") | Some("STATS") | Some("DOCTOR") | Some("MALLOC-STATS")
        ),
        "SLOWLOG" => matches!(
            args.get(1).map(|s| s.to_uppercase()).as_deref(),
            Some("GET") | Some("LEN")
        ),
        _ => false,
    }
}

/// A deliberately narrower allowlist for temporary MCP authorizations.
///
/// The editor's connection-level read-only mode may expose operational
/// introspection such as `CONFIG GET`, `CLIENT LIST`, `INFO`, or `SLOWLOG` to
/// a human operator. Those commands are inappropriate for an AI bridge:
/// configuration output can contain credentials and server topology, while
/// commands such as KEYS/DUMP/XREAD BLOCK can also create avoidable load.
/// Unknown commands and every administrative namespace fail closed.
pub fn line_is_mcp_safe(line: &str) -> bool {
    let args = match parse_args(line) {
        Ok(args) => args,
        Err(_) => return false,
    };
    let Some(command) = args.first() else {
        return false;
    };
    matches!(
        command.to_uppercase().as_str(),
        // strings / generic key inspection
        "GET"
            | "MGET"
            | "GETRANGE"
            | "STRLEN"
            | "EXISTS"
            | "TYPE"
            | "TTL"
            | "PTTL"
            | "SCAN"
            | "RANDOMKEY"
            | "DBSIZE"
            // hash
            | "HGET"
            | "HGETALL"
            | "HMGET"
            | "HLEN"
            | "HKEYS"
            | "HVALS"
            | "HSCAN"
            | "HEXISTS"
            | "HSTRLEN"
            | "HRANDFIELD"
            // list
            | "LRANGE"
            | "LLEN"
            | "LINDEX"
            | "LPOS"
            // set
            | "SMEMBERS"
            | "SCARD"
            | "SISMEMBER"
            | "SMISMEMBER"
            | "SSCAN"
            | "SRANDMEMBER"
            // sorted set
            | "ZRANGE"
            | "ZRANGEBYSCORE"
            | "ZRANGEBYLEX"
            | "ZREVRANGE"
            | "ZCARD"
            | "ZCOUNT"
            | "ZSCORE"
            | "ZMSCORE"
            | "ZRANK"
            | "ZREVRANK"
            | "ZSCAN"
            | "ZRANDMEMBER"
            // stream (non-blocking forms only)
            | "XRANGE"
            | "XREVRANGE"
            | "XLEN"
            // bit / HyperLogLog
            | "BITCOUNT"
            | "BITPOS"
            | "GETBIT"
            | "PFCOUNT"
            // health check
            | "PING"
            // RedisJSON reads
            | "JSON.GET"
            | "JSON.MGET"
            | "JSON.TYPE"
            | "JSON.STRLEN"
            | "JSON.ARRLEN"
            | "JSON.OBJKEYS"
            | "JSON.OBJLEN"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_limit_is_bounded() {
        assert_eq!(bounded_scan_limit(0), 1);
        assert_eq!(bounded_scan_limit(DEFAULT_SCAN_LIMIT), DEFAULT_SCAN_LIMIT);
        assert_eq!(bounded_scan_limit(usize::MAX), MAX_SCAN_LIMIT);
    }

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
    fn line_is_readonly_allows_reads_denies_writes() {
        assert!(line_is_readonly("GET foo"));
        assert!(line_is_readonly("get foo"));
        assert!(line_is_readonly("HGETALL user:1"));
        assert!(line_is_readonly("SCAN 0 MATCH * COUNT 100"));
        assert!(line_is_readonly("CONFIG GET maxmemory"));
        assert!(line_is_readonly("CLIENT LIST"));
        assert!(line_is_readonly("JSON.GET doc $"));

        assert!(!line_is_readonly("SET foo bar"));
        assert!(!line_is_readonly("DEL foo"));
        assert!(!line_is_readonly("HSET user:1 name x"));
        assert!(!line_is_readonly("FLUSHALL"));
        assert!(!line_is_readonly("EXPIRE foo 10"));
        assert!(!line_is_readonly("CONFIG SET maxmemory 0"));
        assert!(!line_is_readonly("CLIENT KILL ID 5"));
        assert!(line_is_readonly("MEMORY USAGE foo"));
        assert!(line_is_readonly("SLOWLOG GET 10"));
        assert!(!line_is_readonly("MEMORY PURGE"));
        assert!(!line_is_readonly("SLOWLOG RESET"));
        // Unknown / unparsable → treated as writes.
        assert!(!line_is_readonly("SOMEFUTURECMD foo"));
        assert!(!line_is_readonly("GET \"unterminated"));
        assert!(!line_is_readonly(""));
    }

    #[test]
    fn mcp_allowlist_rejects_sensitive_and_expensive_introspection() {
        assert!(line_is_mcp_safe("GET profile:1"));
        assert!(line_is_mcp_safe("HGETALL profile:1"));
        assert!(line_is_mcp_safe("SCAN 0 MATCH profile:* COUNT 100"));
        assert!(line_is_mcp_safe("JSON.GET profile:1 $"));

        assert!(!line_is_mcp_safe("CONFIG GET requirepass"));
        assert!(!line_is_mcp_safe("CLIENT LIST"));
        assert!(!line_is_mcp_safe("INFO replication"));
        assert!(!line_is_mcp_safe("SLOWLOG GET 10"));
        assert!(!line_is_mcp_safe("MEMORY STATS"));
        assert!(!line_is_mcp_safe("KEYS *"));
        assert!(!line_is_mcp_safe("DUMP profile:1"));
        assert!(!line_is_mcp_safe("XREAD BLOCK 0 STREAMS events $"));
        assert!(!line_is_mcp_safe("SET profile:1 value"));
    }

    #[test]
    fn reply_to_table_okay_yields_single_ok_cell() {
        let r = reply_to_table(&["SET".into()], RVal::Okay, Instant::now());
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.rows[0][0].as_str(), Some("OK"));
    }

    #[test]
    fn reply_to_table_int_yields_single_int_cell() {
        let r = reply_to_table(&["INCR".into()], RVal::Int(7), Instant::now());
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
        let r = reply_to_table(&["HGETALL".into()], arr, Instant::now());
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
        let r = reply_to_table(&["KEYS".into()], arr, Instant::now());
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.rows.len(), 2);
    }

    #[test]
    fn reply_to_table_nil_yields_null_cell() {
        let r = reply_to_table(&["GET".into()], RVal::Nil, Instant::now());
        assert!(r.rows[0][0].is_null());
    }

    #[test]
    fn reply_to_table_xrange_flattens_entries() {
        let arr = RVal::Array(vec![
            RVal::Array(vec![
                RVal::BulkString(b"1609459200000-0".to_vec()),
                RVal::Array(vec![
                    RVal::BulkString(b"temp".to_vec()),
                    RVal::BulkString(b"21".to_vec()),
                    RVal::BulkString(b"hum".to_vec()),
                    RVal::BulkString(b"40".to_vec()),
                ]),
            ]),
            RVal::Array(vec![
                RVal::BulkString(b"1609459200001-0".to_vec()),
                RVal::Array(vec![
                    RVal::BulkString(b"temp".to_vec()),
                    RVal::BulkString(b"22".to_vec()),
                ]),
            ]),
        ]);
        let r = reply_to_table(&["XRANGE".into()], arr, Instant::now());
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.columns[0].name, "id");
        assert_eq!(r.columns[1].name, "fields");
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][0].as_str(), Some("1609459200000-0"));
        assert_eq!(r.rows[0][1]["temp"], json!("21"));
        assert_eq!(r.rows[1][1]["temp"], json!("22"));
    }

    #[test]
    fn reply_to_table_zrange_withscores_pivots_to_member_score_table() {
        let arr = RVal::Array(vec![
            RVal::BulkString(b"Alice".to_vec()),
            RVal::BulkString(b"100".to_vec()),
            RVal::BulkString(b"Bob".to_vec()),
            RVal::BulkString(b"95".to_vec()),
        ]);
        let r = reply_to_table(
            &["ZRANGE".into(), "key".into(), "0".into(), "-1".into(), "WITHSCORES".into()],
            arr,
            Instant::now()
        );
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.columns[0].name, "field");
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][0].as_str(), Some("Alice"));
        assert_eq!(r.rows[0][1].as_str(), Some("100"));
    }
}
