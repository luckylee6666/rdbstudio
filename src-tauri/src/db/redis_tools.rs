//! Bounded Redis inspection and stream operations used by the tools panel.
use crate::db::pool::RedisHandle;
use crate::error::{AppError, AppResult};
use redis::aio::ConnectionManager;
use serde::Serialize;
use std::collections::BTreeMap;

pub const MAX_PAGE_ITEMS: usize = 500;
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;
pub const MAX_VALUE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct ScanPage<T> {
    pub items: Vec<T>,
    pub cursor: String,
    pub done: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HashEntry {
    pub field: String,
    pub value: String,
    pub field_binary: bool,
    pub value_binary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamEntry {
    pub id: String,
    pub fields: BTreeMap<String, String>,
    pub binary_fields: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamGroup {
    pub name: String,
    pub consumers: u64,
    pub pending: u64,
    pub last_delivered_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterSnapshot {
    pub info: String,
    pub nodes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PubSubMessage {
    pub channel: String,
    pub payload: String,
    pub binary: bool,
    pub received_at_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct PubSubBatch {
    pub messages: Vec<PubSubMessage>,
    pub dropped: u64,
    pub stopped: bool,
}

#[derive(Debug, Clone)]
struct Cursor {
    scan: u64,
    offset: usize,
}

fn encode_cursor(scan: u64, offset: usize) -> String {
    format!("h1:{scan}:{offset}")
}

fn decode_cursor(raw: &str) -> AppResult<Cursor> {
    if raw.is_empty() || raw == "0" {
        return Ok(Cursor { scan: 0, offset: 0 });
    }
    let mut parts = raw.split(':');
    if parts.next() != Some("h1") {
        return Err(AppError::msg("invalid Redis scan cursor"));
    }
    let scan = parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| AppError::msg("invalid Redis scan cursor"))?;
    let offset = parts
        .next()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v <= MAX_PAGE_ITEMS * 10)
        .ok_or_else(|| AppError::msg("invalid Redis scan cursor"))?;
    if parts.next().is_some() {
        return Err(AppError::msg("invalid Redis scan cursor"));
    }
    Ok(Cursor { scan, offset })
}

fn safe_text(bytes: &[u8]) -> (String, bool) {
    if bytes.len() > MAX_VALUE_BYTES {
        return (
            format!("[value omitted: {} bytes]", bytes.len()),
            std::str::from_utf8(bytes).is_err(),
        );
    }
    match std::str::from_utf8(bytes) {
        Ok(value) => (value.to_string(), false),
        Err(_) => (format!("base64:{}", base64(bytes)), true),
    }
}

pub fn display_bytes(bytes: &[u8]) -> (String, bool) {
    safe_text(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let bits = (a << 16) | (b << 8) | c;
        out.push(TABLE[((bits >> 18) & 63) as usize] as char);
        out.push(TABLE[((bits >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn bounded_push<T: Serialize>(items: &mut Vec<T>, item: T, size: &mut usize) -> bool {
    let bytes = serde_json::to_vec(&item)
        .map(|v| v.len())
        .unwrap_or(MAX_PAGE_BYTES);
    if items.len() >= MAX_PAGE_ITEMS || size.saturating_add(bytes) > MAX_PAGE_BYTES {
        return false;
    }
    *size += bytes;
    items.push(item);
    true
}

async fn scan_hash_batch(
    conn: &mut ConnectionManager,
    key: &str,
    cursor: u64,
) -> AppResult<(u64, Vec<(Vec<u8>, Vec<u8>)>)> {
    Ok(redis::cmd("HSCAN")
        .arg(key)
        .arg(cursor)
        .arg("COUNT")
        .arg(100)
        .query_async(conn)
        .await?)
}

pub async fn hscan(
    handle: &RedisHandle,
    key: &str,
    cursor: &str,
) -> AppResult<ScanPage<HashEntry>> {
    let Cursor {
        mut scan,
        mut offset,
    } = decode_cursor(cursor)?;
    let mut conn = handle.conn();
    let mut items = Vec::new();
    let mut size = 0;
    loop {
        let (next, batch) = scan_hash_batch(&mut conn, key, scan).await?;
        if offset > batch.len() {
            return Err(AppError::msg(
                "Redis scan cursor no longer matches this key",
            ));
        }
        let mut consumed = 0;
        let mut truncated = false;
        for (field, value) in batch.iter().skip(offset) {
            let (field, field_binary) = safe_text(field);
            let (value, value_binary) = safe_text(value);
            let entry = HashEntry {
                field,
                value,
                field_binary,
                value_binary,
            };
            if !bounded_push(&mut items, entry, &mut size) {
                truncated = true;
                break;
            }
            consumed += 1;
        }
        if truncated {
            return Ok(ScanPage {
                items,
                cursor: encode_cursor(scan, offset + consumed),
                done: false,
                truncated: true,
            });
        }
        offset = 0;
        if next == 0 {
            return Ok(ScanPage {
                items,
                cursor: "0".into(),
                done: true,
                truncated: false,
            });
        }
        scan = next;
        if items.len() >= MAX_PAGE_ITEMS || size >= MAX_PAGE_BYTES || !items.is_empty() {
            return Ok(ScanPage {
                items,
                cursor: encode_cursor(scan, 0),
                done: false,
                truncated: false,
            });
        }
    }
}

async fn scan_set_batch(
    conn: &mut ConnectionManager,
    key: &str,
    cursor: u64,
) -> AppResult<(u64, Vec<Vec<u8>>)> {
    Ok(redis::cmd("SSCAN")
        .arg(key)
        .arg(cursor)
        .arg("COUNT")
        .arg(100)
        .query_async(conn)
        .await?)
}

pub async fn sscan(handle: &RedisHandle, key: &str, cursor: &str) -> AppResult<ScanPage<String>> {
    let Cursor {
        mut scan,
        mut offset,
    } = decode_cursor(cursor)?;
    let mut conn = handle.conn();
    let mut items = Vec::new();
    let mut size = 0;
    loop {
        let (next, batch) = scan_set_batch(&mut conn, key, scan).await?;
        if offset > batch.len() {
            return Err(AppError::msg(
                "Redis scan cursor no longer matches this key",
            ));
        }
        let mut consumed = 0;
        let mut truncated = false;
        for bytes in batch.iter().skip(offset) {
            let (value, _) = safe_text(bytes);
            if !bounded_push(&mut items, value, &mut size) {
                truncated = true;
                break;
            }
            consumed += 1;
        }
        if truncated {
            return Ok(ScanPage {
                items,
                cursor: encode_cursor(scan, offset + consumed),
                done: false,
                truncated: true,
            });
        }
        offset = 0;
        if next == 0 {
            return Ok(ScanPage {
                items,
                cursor: "0".into(),
                done: true,
                truncated: false,
            });
        }
        scan = next;
        if items.len() >= MAX_PAGE_ITEMS || size >= MAX_PAGE_BYTES || !items.is_empty() {
            return Ok(ScanPage {
                items,
                cursor: encode_cursor(scan, 0),
                done: false,
                truncated: false,
            });
        }
    }
}

fn decode_field(bytes: &[u8]) -> (String, bool) {
    safe_text(bytes)
}

fn stream_entry(id: String, values: Vec<(Vec<u8>, Vec<u8>)>) -> StreamEntry {
    let mut fields = BTreeMap::new();
    let mut binary_fields = Vec::new();
    let mut truncated = false;
    let mut bytes = 0usize;
    let omitted_fields = values.len() > MAX_PAGE_ITEMS;
    for (key, value) in values.into_iter().take(MAX_PAGE_ITEMS) {
        let (key, key_binary) = decode_field(&key);
        let (value, value_binary) = safe_text(&value);
        let item_bytes = key.len().saturating_add(value.len());
        if bytes.saturating_add(item_bytes) > MAX_PAGE_BYTES {
            truncated = true;
            break;
        }
        bytes += item_bytes;
        if key_binary || value_binary {
            binary_fields.push(key.clone());
        }
        truncated |= value.starts_with("[value omitted:");
        fields.insert(key, value);
    }
    StreamEntry {
        id,
        fields,
        binary_fields,
        truncated: truncated || omitted_fields,
    }
}

pub async fn xrange(
    handle: &RedisHandle,
    key: &str,
    start: &str,
    count: usize,
    reverse: bool,
) -> AppResult<ScanPage<StreamEntry>> {
    let count = count.clamp(1, MAX_PAGE_ITEMS);
    let mut conn = handle.conn();
    let (cmd, left, right) = if reverse {
        ("XREVRANGE", start, "-")
    } else {
        ("XRANGE", start, "+")
    };
    type StreamWireEntry = (String, Vec<(Vec<u8>, Vec<u8>)>);
    let mut results: Vec<StreamWireEntry> = redis::cmd(cmd)
        .arg(key)
        .arg(left)
        .arg(right)
        .arg("COUNT")
        .arg(count + 1)
        .query_async(&mut conn)
        .await?;
    let has_more = results.len() > count;
    if has_more {
        results.truncate(count);
    }
    let expected_items = results.len();
    let mut entries = Vec::with_capacity(results.len());
    let mut size = 0;
    for (id, values) in results {
        let entry = stream_entry(id, values);
        if !bounded_push(&mut entries, entry, &mut size) {
            break;
        }
    }
    let cursor = entries
        .last()
        .map(|e| format!("({}", e.id))
        .unwrap_or_else(|| start.to_string());
    let byte_truncated =
        entries.len() < expected_items || entries.iter().any(|entry| entry.truncated);
    Ok(ScanPage {
        items: entries,
        cursor,
        done: !has_more,
        truncated: byte_truncated,
    })
}

pub async fn xadd(
    handle: &RedisHandle,
    key: &str,
    fields: &[(String, String)],
) -> AppResult<String> {
    if fields.is_empty() || fields.len() > 64 {
        return Err(AppError::msg("stream entry requires 1 to 64 fields"));
    }
    let mut conn = handle.conn();
    let mut cmd = redis::cmd("XADD");
    cmd.arg(key).arg("*");
    for (field, value) in fields {
        cmd.arg(field).arg(value);
    }
    Ok(cmd.query_async(&mut conn).await?)
}

pub async fn xdel(handle: &RedisHandle, key: &str, ids: &[String]) -> AppResult<u64> {
    if ids.is_empty() || ids.len() > MAX_PAGE_ITEMS {
        return Err(AppError::msg("select 1 to 500 stream entries"));
    }
    let mut conn = handle.conn();
    let mut cmd = redis::cmd("XDEL");
    cmd.arg(key);
    for id in ids {
        cmd.arg(id);
    }
    Ok(cmd.query_async(&mut conn).await?)
}

pub async fn xinfo_groups(handle: &RedisHandle, key: &str) -> AppResult<Vec<StreamGroup>> {
    let mut conn = handle.conn();
    let rows: Vec<redis::Value> = redis::cmd("XINFO")
        .arg("GROUPS")
        .arg(key)
        .query_async(&mut conn)
        .await?;
    let mut groups = Vec::new();
    for row in rows.into_iter().take(MAX_PAGE_ITEMS) {
        let mut fields = BTreeMap::new();
        if let redis::Value::Array(items) = row {
            for pair in items.chunks(2) {
                if pair.len() != 2 {
                    continue;
                }
                let k = redis::from_redis_value::<String>(&pair[0]).unwrap_or_default();
                fields.insert(k, pair[1].clone());
            }
        }
        let string = |key: &str| {
            fields
                .get(key)
                .and_then(|v| redis::from_redis_value::<String>(v).ok())
                .unwrap_or_default()
        };
        let number = |key: &str| {
            fields
                .get(key)
                .and_then(|v| redis::from_redis_value::<u64>(v).ok())
                .unwrap_or(0)
        };
        groups.push(StreamGroup {
            name: string("name"),
            consumers: number("consumers"),
            pending: number("pending"),
            last_delivered_id: string("last-delivered-id"),
        });
    }
    Ok(groups)
}

pub async fn xgroup_create(handle: &RedisHandle, key: &str, group: &str) -> AppResult<()> {
    let mut conn = handle.conn();
    let _: String = redis::cmd("XGROUP")
        .arg("CREATE")
        .arg(key)
        .arg(group)
        .arg("$")
        .arg("MKSTREAM")
        .query_async(&mut conn)
        .await?;
    Ok(())
}

pub async fn xgroup_destroy(handle: &RedisHandle, key: &str, group: &str) -> AppResult<bool> {
    let mut conn = handle.conn();
    let deleted: i64 = redis::cmd("XGROUP")
        .arg("DESTROY")
        .arg(key)
        .arg(group)
        .query_async(&mut conn)
        .await?;
    Ok(deleted > 0)
}

pub async fn cluster_snapshot(handle: &RedisHandle) -> AppResult<ClusterSnapshot> {
    let mut conn = handle.conn();
    let info: String = redis::cmd("CLUSTER")
        .arg("INFO")
        .query_async(&mut conn)
        .await?;
    let nodes: String = redis::cmd("CLUSTER")
        .arg("NODES")
        .query_async(&mut conn)
        .await?;
    Ok(ClusterSnapshot {
        info: info.chars().take(MAX_VALUE_BYTES).collect(),
        nodes: nodes
            .lines()
            .take(500)
            .map(|line| line.chars().take(MAX_VALUE_BYTES).collect())
            .collect(),
    })
}

/// Compare a list slot's expected old bytes before replacing it. A shifted or
/// concurrently updated slot fails without overwriting another value.
pub async fn list_set_cas(
    handle: &RedisHandle,
    key: &str,
    index: usize,
    expected: &str,
    next: &str,
) -> AppResult<()> {
    if index > i64::MAX as usize {
        return Err(AppError::msg("list index is out of range"));
    }
    let script = redis::Script::new(
        r#"
local current = redis.call('LINDEX', KEYS[1], ARGV[1])
if current == false then return redis.error_reply('list item no longer exists') end
if current ~= ARGV[2] then return redis.error_reply('list item changed; refresh before editing') end
return redis.call('LSET', KEYS[1], ARGV[1], ARGV[3])
"#,
    );
    let mut conn = handle.conn();
    let _: String = script
        .key(key)
        .arg(index)
        .arg(expected)
        .arg(next)
        .invoke_async(&mut conn)
        .await?;
    Ok(())
}

/// Delete one list slot only if the expected value still occupies that index.
/// Shift the shorter side of the list so deleting a displayed prefix row is
/// bounded even when the list is very large. LSET/LPOP/RPOP preserve the key TTL.
pub async fn list_delete_cas(
    handle: &RedisHandle,
    key: &str,
    index: usize,
    expected: &str,
) -> AppResult<()> {
    if index > i64::MAX as usize {
        return Err(AppError::msg("list index is out of range"));
    }
    let script = redis::Script::new(
        r#"
local index = tonumber(ARGV[1])
local length = redis.call('LLEN', KEYS[1])
if index < 0 or index >= length then
  return redis.error_reply('list item no longer exists')
end
local current = redis.call('LINDEX', KEYS[1], index)
if current ~= ARGV[2] then
  return redis.error_reply('list item changed; refresh before deleting')
end
local left = index
local right = length - index - 1
if math.min(left, right) > 10000 then
  return redis.error_reply('list item is too far from either end to delete safely')
end
if left <= right then
  for i = index, 1, -1 do
    redis.call('LSET', KEYS[1], i, redis.call('LINDEX', KEYS[1], i - 1))
  end
  redis.call('LPOP', KEYS[1])
else
  for i = index, length - 2 do
    redis.call('LSET', KEYS[1], i, redis.call('LINDEX', KEYS[1], i + 1))
  end
  redis.call('RPOP', KEYS[1])
end
return 1
"#,
    );
    let mut conn = handle.conn();
    let _: i64 = script
        .key(key)
        .arg(index)
        .arg(expected)
        .invoke_async(&mut conn)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_hash_set_cursor_roundtrips_and_rejects_tampering() {
        let cursor = encode_cursor(42, 17);
        assert_eq!(decode_cursor(&cursor).unwrap().scan, 42);
        assert_eq!(decode_cursor(&cursor).unwrap().offset, 17);
        assert!(decode_cursor("h1:1:999999").is_err());
        assert!(decode_cursor("not-a-cursor").is_err());
    }

    #[test]
    fn binary_values_are_explicit_and_large_values_are_omitted() {
        assert_eq!(safe_text(b"ok"), ("ok".into(), false));
        assert_eq!(safe_text(&[0xff]).0, "base64:/w==");
        assert!(safe_text(&vec![b'x'; MAX_VALUE_BYTES + 1])
            .0
            .starts_with("[value omitted:"));
    }
}
