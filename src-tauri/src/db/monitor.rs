use crate::db::meta;
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::Serialize;
use sqlx::Row;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct MonitorMetric {
    pub key: String,
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerProcess {
    pub id: String,
    pub user: Option<String>,
    pub database: Option<String>,
    pub client: Option<String>,
    pub state: Option<String>,
    pub command: Option<String>,
    pub duration_sec: Option<i64>,
    pub wait_info: Option<String>,
    pub query: Option<String>,
    pub is_self: bool,
    pub killable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerMonitorSnapshot {
    pub driver: DriverKind,
    pub server_version: String,
    pub metrics: Vec<MonitorMetric>,
    pub processes: Vec<ServerProcess>,
}

pub async fn server_monitor_snapshot(pool: &DbPool) -> AppResult<ServerMonitorSnapshot> {
    let server_version = meta::server_version(pool)
        .await
        .unwrap_or_else(|_| format!("{:?}", pool.driver()));
    match pool {
        DbPool::Postgres(p) => snapshot_postgres(p, server_version).await,
        DbPool::Mysql(p) => snapshot_mysql(p, server_version).await,
        DbPool::Redis(h) => snapshot_redis(h, server_version).await,
        DbPool::Sqlite(p) => snapshot_sqlite(p, server_version).await,
    }
}

pub async fn kill_server_process(
    pool: &DbPool,
    process_id: &str,
    cancel_only: bool,
) -> AppResult<()> {
    let pid: u64 = process_id
        .trim()
        .parse()
        .map_err(|_| AppError::msg(format!("invalid numeric process id: {process_id}")))?;
    match pool {
        DbPool::Postgres(p) => {
            let pid_i32 = i32::try_from(pid)
                .map_err(|_| AppError::msg(format!("process id out of range: {pid}")))?;
            let sql = if cancel_only {
                "SELECT pg_cancel_backend($1)"
            } else {
                "SELECT pg_terminate_backend($1)"
            };
            let ok: bool = sqlx::query_scalar(sql)
                .bind(pid_i32)
                .fetch_one(p)
                .await?;
            if !ok {
                return Err(AppError::msg(format!(
                    "server could not terminate backend {pid} (already exited or insufficient privilege)"
                )));
            }
            Ok(())
        }
        DbPool::Mysql(p) => {
            let sql = if cancel_only {
                format!("KILL QUERY {pid}")
            } else {
                format!("KILL {pid}")
            };
            sqlx::query(&sql).execute(p).await?;
            Ok(())
        }
        DbPool::Redis(h) => {
            let mut conn = h.conn();
            let _: redis::Value = redis::cmd("CLIENT")
                .arg("KILL")
                .arg("ID")
                .arg(pid)
                .query_async(&mut conn)
                .await?;
            Ok(())
        }
        DbPool::Sqlite(_) => Err(AppError::msg(
            "SQLite is an embedded file database and has no remote server sessions to terminate",
        )),
    }
}

async fn snapshot_postgres(
    p: &sqlx::PgPool,
    server_version: String,
) -> AppResult<ServerMonitorSnapshot> {
    let rows = sqlx::query(
        "SELECT pid::text AS id, \
                usename AS user_name, \
                datname AS db_name, \
                COALESCE(client_addr::text, application_name, 'local') AS client, \
                COALESCE(state, backend_type) AS state, \
                backend_type AS command, \
                GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(query_start, backend_start)))::bigint, 0)) AS duration_sec, \
                CASE WHEN wait_event_type IS NOT NULL THEN wait_event_type || ':' || COALESCE(wait_event, '') ELSE NULL END AS wait_info, \
                query, \
                (pid = pg_backend_pid()) AS is_self \
         FROM pg_stat_activity \
         WHERE pid IS NOT NULL \
         ORDER BY is_self ASC, duration_sec DESC \
         LIMIT 200",
    )
    .fetch_all(p)
    .await?;

    let mut processes = Vec::with_capacity(rows.len());
    let mut active_count = 0usize;
    for r in rows {
        let id: String = r.try_get("id").unwrap_or_default();
        let state: Option<String> = r.try_get("state").ok().flatten();
        if state.as_deref() == Some("active") {
            active_count += 1;
        }
        let is_self: bool = r.try_get("is_self").unwrap_or(false);
        processes.push(ServerProcess {
            id,
            user: r.try_get("user_name").ok().flatten(),
            database: r.try_get("db_name").ok().flatten(),
            client: r.try_get("client").ok().flatten(),
            state,
            command: r.try_get("command").ok().flatten(),
            duration_sec: r.try_get("duration_sec").ok().flatten(),
            wait_info: r.try_get("wait_info").ok().flatten(),
            query: r.try_get("query").ok().flatten(),
            is_self,
            killable: !is_self,
        });
    }

    let mut metrics = vec![
        MonitorMetric {
            key: "total_sessions".into(),
            label: "Total Sessions".into(),
            value: processes.len().to_string(),
        },
        MonitorMetric {
            key: "active_sessions".into(),
            label: "Active Queries".into(),
            value: active_count.to_string(),
        },
    ];

    if let Ok(Some(stat)) = sqlx::query(
        "SELECT xact_commit::bigint AS commits, \
                xact_rollback::bigint AS rollbacks, \
                blks_hit::bigint AS blks_hit, \
                blks_read::bigint AS blks_read \
         FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_optional(p)
    .await
    {
        let commits: i64 = stat.try_get("commits").unwrap_or(0);
        let rollbacks: i64 = stat.try_get("rollbacks").unwrap_or(0);
        let hit: i64 = stat.try_get("blks_hit").unwrap_or(0);
        let read: i64 = stat.try_get("blks_read").unwrap_or(0);
        metrics.push(MonitorMetric {
            key: "xact_commit".into(),
            label: "Committed Txns".into(),
            value: commits.to_string(),
        });
        metrics.push(MonitorMetric {
            key: "xact_rollback".into(),
            label: "Rolled Back Txns".into(),
            value: rollbacks.to_string(),
        });
        if hit + read > 0 {
            let ratio = (hit as f64 / (hit + read) as f64) * 100.0;
            metrics.push(MonitorMetric {
                key: "cache_hit_ratio".into(),
                label: "Cache Hit Ratio".into(),
                value: format!("{ratio:.2}%"),
            });
        }
    }

    Ok(ServerMonitorSnapshot {
        driver: DriverKind::Postgres,
        server_version,
        metrics,
        processes,
    })
}

async fn snapshot_mysql(
    p: &sqlx::MySqlPool,
    server_version: String,
) -> AppResult<ServerMonitorSnapshot> {
    let rows = sqlx::query(
        "SELECT CAST(ID AS CHAR) AS id, \
                USER AS user_name, \
                DB AS db_name, \
                HOST AS client, \
                STATE AS state, \
                COMMAND AS command, \
                CAST(TIME AS SIGNED) AS duration_sec, \
                INFO AS query, \
                (ID = CONNECTION_ID()) AS is_self \
         FROM information_schema.PROCESSLIST \
         ORDER BY is_self ASC, TIME DESC \
         LIMIT 200",
    )
    .fetch_all(p)
    .await?;

    let mut processes = Vec::with_capacity(rows.len());
    let mut active_count = 0usize;
    for r in rows {
        let id = crate::db::meta::mysql_show_str(&r, "id", 0).unwrap_or_default();
        let command = crate::db::meta::mysql_show_str(&r, "command", 5);
        if command
            .as_deref()
            .map(|c| !c.eq_ignore_ascii_case("Sleep"))
            .unwrap_or(false)
        {
            active_count += 1;
        }
        let is_self: i64 = r.try_get("is_self").unwrap_or(0);
        let self_flag = is_self != 0;
        processes.push(ServerProcess {
            id,
            user: crate::db::meta::mysql_show_str(&r, "user_name", 1),
            database: crate::db::meta::mysql_show_str(&r, "db_name", 2),
            client: crate::db::meta::mysql_show_str(&r, "client", 3),
            state: crate::db::meta::mysql_show_str(&r, "state", 4),
            command,
            duration_sec: r.try_get::<Option<i64>, _>("duration_sec").ok().flatten(),
            wait_info: None,
            query: crate::db::meta::mysql_show_str(&r, "query", 7),
            is_self: self_flag,
            killable: !self_flag,
        });
    }

    let mut metrics = vec![
        MonitorMetric {
            key: "total_sessions".into(),
            label: "Total Connections".into(),
            value: processes.len().to_string(),
        },
        MonitorMetric {
            key: "active_sessions".into(),
            label: "Active Threads".into(),
            value: active_count.to_string(),
        },
    ];

    if let Ok(status_rows) = sqlx::query(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Questions', 'Slow_queries')",
    )
    .fetch_all(p)
    .await
    {
        for sr in status_rows {
            let k = crate::db::meta::mysql_show_str(&sr, "Variable_name", 0).unwrap_or_default();
            let v = crate::db::meta::mysql_show_str(&sr, "Value", 1).unwrap_or_default();
            if !k.is_empty() {
                metrics.push(MonitorMetric {
                    key: k.to_ascii_lowercase(),
                    label: k.replace('_', " "),
                    value: v,
                });
            }
        }
    }

    Ok(ServerMonitorSnapshot {
        driver: DriverKind::Mysql,
        server_version,
        metrics,
        processes,
    })
}

pub fn parse_redis_client_list(raw: &str) -> Vec<ServerProcess> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut fields: HashMap<&str, &str> = HashMap::new();
        for token in trimmed.split_whitespace() {
            if let Some((k, v)) = token.split_once('=') {
                fields.insert(k, v);
            }
        }
        let Some(id) = fields.get("id").copied() else {
            continue;
        };
        let idle: i64 = fields
            .get("idle")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let age: Option<i64> = fields.get("age").and_then(|s| s.parse().ok());
        let db = fields.get("db").map(|d| format!("db{d}"));
        let cmd = fields.get("cmd").map(|s| (*s).to_string());
        let user = fields.get("user").map(|s| (*s).to_string());
        let addr = fields.get("addr").map(|s| (*s).to_string());
        let name = fields
            .get("name")
            .filter(|s| !s.is_empty())
            .map(|s| (*s).to_string());
        let client_label = match (addr, name) {
            (Some(a), Some(n)) => Some(format!("{a} ({n})")),
            (Some(a), None) => Some(a),
            (None, Some(n)) => Some(n),
            (None, None) => None,
        };
        out.push(ServerProcess {
            id: id.to_string(),
            user,
            database: db,
            client: client_label,
            state: Some(if idle == 0 { "active".into() } else { "idle".into() }),
            command: cmd.clone(),
            duration_sec: age,
            wait_info: Some(format!("idle {idle}s")),
            query: cmd,
            is_self: false,
            killable: true,
        });
    }
    out
}

async fn snapshot_redis(
    h: &crate::db::pool::RedisHandle,
    server_version: String,
) -> AppResult<ServerMonitorSnapshot> {
    let mut conn = h.conn();
    let (info_raw, client_raw): (String, String) = redis::pipe()
        .cmd("INFO")
        .cmd("CLIENT")
        .arg("LIST")
        .query_async(&mut conn)
        .await?;

    let mut info_map: HashMap<&str, &str> = HashMap::new();
    for line in info_raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = t.split_once(':') {
            info_map.insert(k.trim(), v.trim());
        }
    }

    let processes = parse_redis_client_list(&client_raw);
    let mut metrics = Vec::new();
    for (key, label) in [
        ("connected_clients", "Connected Clients"),
        ("used_memory_human", "Used Memory"),
        ("instantaneous_ops_per_sec", "Ops / Sec"),
        ("total_commands_processed", "Total Commands"),
        ("uptime_in_seconds", "Uptime (s)"),
    ] {
        if let Some(val) = info_map.get(key) {
            metrics.push(MonitorMetric {
                key: key.into(),
                label: label.into(),
                value: (*val).into(),
            });
        }
    }

    Ok(ServerMonitorSnapshot {
        driver: DriverKind::Redis,
        server_version,
        metrics,
        processes,
    })
}

fn format_bytes(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

async fn snapshot_sqlite(
    p: &sqlx::SqlitePool,
    server_version: String,
) -> AppResult<ServerMonitorSnapshot> {
    let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(p)
        .await
        .unwrap_or(0);
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(p)
        .await
        .unwrap_or(4096);
    let freelist_count: i64 = sqlx::query_scalar("PRAGMA freelist_count")
        .fetch_one(p)
        .await
        .unwrap_or(0);
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(p)
        .await
        .unwrap_or_else(|_| "unknown".into());

    let total_bytes = page_count.saturating_mul(page_size);
    let free_bytes = freelist_count.saturating_mul(page_size);

    let metrics = vec![
        MonitorMetric {
            key: "database_size".into(),
            label: "Database Size".into(),
            value: format_bytes(total_bytes),
        },
        MonitorMetric {
            key: "free_space".into(),
            label: "Free List Space".into(),
            value: format_bytes(free_bytes),
        },
        MonitorMetric {
            key: "page_count".into(),
            label: "Pages".into(),
            value: format!("{page_count} ({page_size} B)"),
        },
        MonitorMetric {
            key: "journal_mode".into(),
            label: "Journal Mode".into(),
            value: journal_mode.to_uppercase(),
        },
    ];

    let db_rows = sqlx::query("PRAGMA database_list")
        .fetch_all(p)
        .await
        .unwrap_or_default();
    let mut processes = Vec::with_capacity(db_rows.len());
    for r in db_rows {
        let seq: i64 = r.try_get("seq").unwrap_or(0);
        let name: String = r.try_get("name").unwrap_or_else(|_| "main".into());
        let file: String = r.try_get("file").unwrap_or_default();
        processes.push(ServerProcess {
            id: seq.to_string(),
            user: Some("local".into()),
            database: Some(name),
            client: Some("embedded".into()),
            state: Some("attached".into()),
            command: Some("SQLite".into()),
            duration_sec: Some(0),
            wait_info: None,
            query: Some(if file.is_empty() {
                ":memory:".into()
            } else {
                file
            }),
            is_self: true,
            killable: false,
        });
    }

    Ok(ServerMonitorSnapshot {
        driver: DriverKind::Sqlite,
        server_version,
        metrics,
        processes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_redis_client_list_extracts_fields_and_state() {
        let sample = "id=14 addr=127.0.0.1:52144 laddr=127.0.0.1:6379 fd=8 name=app-worker age=120 idle=0 flags=N db=2 sub=0 psub=0 ssub=0 multi=-1 qbuf=26 qbuf-free=20448 argv-mem=10 multi-mem=0 rbs=1024 rbp=0 obl=0 oll=0 omem=0 tot-mem=22298 events=r cmd=get user=default redir=-1 resp=2\n\
                      id=15 addr=127.0.0.1:52145 fd=9 name= age=45 idle=12 db=0 cmd=ping user=default\n";
        let list = parse_redis_client_list(sample);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "14");
        assert_eq!(list[0].database.as_deref(), Some("db2"));
        assert_eq!(list[0].state.as_deref(), Some("active"));
        assert_eq!(
            list[0].client.as_deref(),
            Some("127.0.0.1:52144 (app-worker)")
        );
        assert_eq!(list[1].id, "15");
        assert_eq!(list[1].state.as_deref(), Some("idle"));
        assert_eq!(list[1].wait_info.as_deref(), Some("idle 12s"));
    }
}
