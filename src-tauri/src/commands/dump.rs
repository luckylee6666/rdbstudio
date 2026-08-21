//! Whole-database dump & restore.
//!
//! SQLite dumps through the live pool with `VACUUM INTO` (consistent snapshot,
//! no external tooling). Postgres/MySQL shell out to the stock client tools
//! (`pg_dump`/`psql`, `mysqldump`/`mysql`) — re-implementing their dump logic
//! would be a project of its own. The binaries are resolved from PATH plus the
//! usual Homebrew/libpq install locations, because GUI apps on macOS launch
//! with a minimal PATH.

use crate::db::pool::DbPool;
use crate::db::{ssl_mode_of, target_addr, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, DriverKind};
use crate::secret;
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
pub struct DumpReport {
    pub path: String,
    pub bytes: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreReport {
    pub elapsed_ms: u64,
}

/// Locate a client binary by name. PATH first, then common install locations
/// the app doesn't inherit: a launchd-spawned macOS GUI app gets a minimal
/// PATH, and Windows installers put the tools in versioned Program Files
/// directories that are rarely on PATH at all.
fn find_binary(names: &[&str]) -> Option<PathBuf> {
    #[cfg(not(target_os = "windows"))]
    const EXTRA_DIRS: &[&str] = &[
        "/opt/homebrew/bin",
        "/opt/homebrew/opt/libpq/bin",
        "/opt/homebrew/opt/mysql-client/bin",
        "/usr/local/bin",
        "/usr/local/opt/libpq/bin",
        "/usr/local/opt/mysql-client/bin",
        "/usr/bin",
    ];
    #[cfg(target_os = "windows")]
    const EXTRA_DIRS: &[&str] = &[];
    // Parents whose versioned children hold a bin/ (…\PostgreSQL\16\bin).
    #[cfg(target_os = "windows")]
    const VERSIONED_PARENTS: &[&str] = &[
        r"C:\Program Files\PostgreSQL",
        r"C:\Program Files\MySQL",
        r"C:\Program Files\MariaDB",
    ];

    for name in names {
        // EXE_SUFFIX is ".exe" on Windows, "" elsewhere — a literal is_file()
        // probe for "pg_dump" would miss "pg_dump.exe".
        let file = format!("{}{}", name, std::env::consts::EXE_SUFFIX);
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let p = dir.join(&file);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        for d in EXTRA_DIRS {
            let p = Path::new(d).join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
        #[cfg(target_os = "windows")]
        for parent in VERSIONED_PARENTS {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for e in entries.flatten() {
                    let p = e.path().join("bin").join(&file);
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

/// Effective server address: the SSH tunnel's local forward when one is up,
/// otherwise the configured host/port.
fn effective_addr(state: &AppState, cfg: &ConnectionConfig) -> AppResult<(String, u16)> {
    if let Some(t) = state.tunnels.read().get(&cfg.id) {
        return Ok((t.local_host.clone(), t.local_port));
    }
    if cfg.ssh.is_some() {
        return Err(AppError::msg(
            "this connection uses an SSH tunnel — connect first so the tunnel is up",
        ));
    }
    Ok(target_addr(cfg))
}

/// Mirror `build_url_with`: a tunnel dials localhost, so verify-full cannot
/// validate the original database hostname. Refuse to weaken the policy.
fn dump_ssl_mode(cfg: &ConnectionConfig, via_tunnel: bool) -> AppResult<Option<SslMode>> {
    let mode = ssl_mode_of(cfg);
    if via_tunnel && mode == Some(SslMode::VerifyFull) {
        return Err(AppError::msg(
            "verify-full TLS cannot be used through an SSH tunnel because the client connects to localhost; choose require explicitly or connect directly",
        ));
    }
    Ok(mode)
}

fn apply_pg_ssl(
    cmd: &mut tokio::process::Command,
    cfg: &ConnectionConfig,
    via_tunnel: bool,
) -> AppResult<()> {
    if let Some(mode) = dump_ssl_mode(cfg, via_tunnel)? {
        cmd.env(
            "PGSSLMODE",
            match mode {
                SslMode::Disable => "disable",
                SslMode::Require => "require",
                SslMode::VerifyCa => "verify-ca",
                SslMode::VerifyFull => "verify-full",
            },
        );
    }
    Ok(())
}

fn apply_mysql_ssl(
    cmd: &mut tokio::process::Command,
    cfg: &ConnectionConfig,
    via_tunnel: bool,
) -> AppResult<()> {
    if let Some(mode) = dump_ssl_mode(cfg, via_tunnel)? {
        cmd.arg("--ssl-mode").arg(match mode {
            SslMode::Disable => "DISABLED",
            SslMode::Require => "REQUIRED",
            SslMode::VerifyCa => "VERIFY_CA",
            SslMode::VerifyFull => "VERIFY_IDENTITY",
        });
    }
    Ok(())
}

fn tail_of(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.len() <= max {
        t.to_string()
    } else {
        format!("…{}", &t[t.len() - max..])
    }
}

async fn run_tool(mut cmd: tokio::process::Command, tool: &str) -> AppResult<()> {
    let out = cmd
        .output()
        .await
        .map_err(|e| AppError::msg(format!("failed to launch {tool}: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::msg(format!(
            "{tool} exited with {}: {}",
            out.status,
            tail_of(&stderr, 800)
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn dump_database(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
) -> AppResult<DumpReport> {
    let cfg = state
        .store
        .get(&id)
        .ok_or_else(|| AppError::msg("unknown connection"))?;
    let start = std::time::Instant::now();

    match cfg.driver {
        DriverKind::Redis => {
            return Err(AppError::msg(
                "dump is not supported for Redis (use the server's RDB/AOF persistence)",
            ))
        }
        DriverKind::Sqlite => {
            let pool = state
                .get_pool(&id)
                .ok_or_else(|| AppError::msg("not connected"))?;
            let DbPool::Sqlite(p) = &pool else {
                return Err(AppError::msg("not a SQLite connection"));
            };
            // VACUUM INTO refuses to overwrite; the save dialog already asked.
            if Path::new(&dest_path).exists() {
                std::fs::remove_file(&dest_path)?;
            }
            let sql = format!("VACUUM INTO '{}'", dest_path.replace('\'', "''"));
            sqlx::query(&sql).execute(p).await?;
        }
        DriverKind::Postgres => {
            let bin = find_binary(&["pg_dump"]).ok_or_else(|| {
                AppError::msg(
                    "pg_dump not found — install it (e.g. `brew install libpq`) and retry",
                )
            })?;
            let (host, port) = effective_addr(&state, &cfg)?;
            let via_tunnel = state.tunnels.read().contains_key(&cfg.id);
            let db = cfg
                .database
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("postgres");
            let mut cmd = tokio::process::Command::new(bin);
            cmd.arg("--host")
                .arg(&host)
                .arg("--port")
                .arg(port.to_string())
                .arg("--dbname")
                .arg(db)
                .arg("--no-password")
                .arg("--format=plain")
                .arg("--file")
                .arg(&dest_path);
            if let Some(u) = cfg.username.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("--username").arg(u);
            }
            if let Some(pw) = secret::read_password(&id)? {
                cmd.env("PGPASSWORD", pw);
            }
            apply_pg_ssl(&mut cmd, &cfg, via_tunnel)?;
            run_tool(cmd, "pg_dump").await?;
        }
        DriverKind::Mysql => {
            let bin = find_binary(&["mysqldump", "mariadb-dump"]).ok_or_else(|| {
                AppError::msg(
                    "mysqldump not found — install it (e.g. `brew install mysql-client`) and retry",
                )
            })?;
            let (host, port) = effective_addr(&state, &cfg)?;
            let via_tunnel = state.tunnels.read().contains_key(&cfg.id);
            let db = cfg
                .database
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::msg("set a database on the connection first"))?;
            let mut cmd = tokio::process::Command::new(bin);
            cmd.arg("--host")
                .arg(&host)
                .arg("--port")
                .arg(port.to_string())
                .arg("--single-transaction")
                .arg("--routines")
                .arg("--result-file")
                .arg(&dest_path)
                .arg(db);
            if let Some(u) = cfg.username.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("--user").arg(u);
            }
            if let Some(pw) = secret::read_password(&id)? {
                cmd.env("MYSQL_PWD", pw);
            }
            apply_mysql_ssl(&mut cmd, &cfg, via_tunnel)?;
            run_tool(cmd, "mysqldump").await?;
        }
    }

    let bytes = std::fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
    Ok(DumpReport {
        path: dest_path,
        bytes,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn restore_database(
    state: State<'_, AppState>,
    id: String,
    src_path: String,
) -> AppResult<RestoreReport> {
    crate::commands::ensure_writable(&state, &id)?;
    let cfg = state
        .store
        .get(&id)
        .ok_or_else(|| AppError::msg("unknown connection"))?;
    if !Path::new(&src_path).is_file() {
        return Err(AppError::msg("SQL file not found"));
    }
    let start = std::time::Instant::now();

    match cfg.driver {
        DriverKind::Sqlite => {
            return Err(AppError::msg(
                "SQLite restore = open the dumped .db file as a new connection",
            ))
        }
        DriverKind::Redis => return Err(AppError::msg("restore is not supported for Redis")),
        DriverKind::Postgres => {
            let bin = find_binary(&["psql"]).ok_or_else(|| {
                AppError::msg("psql not found — install it (e.g. `brew install libpq`) and retry")
            })?;
            let (host, port) = effective_addr(&state, &cfg)?;
            let via_tunnel = state.tunnels.read().contains_key(&cfg.id);
            let db = cfg
                .database
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("postgres");
            let mut cmd = tokio::process::Command::new(bin);
            cmd.arg("--host")
                .arg(&host)
                .arg("--port")
                .arg(port.to_string())
                .arg("--dbname")
                .arg(db)
                .arg("--no-password")
                .arg("-v")
                .arg("ON_ERROR_STOP=1")
                .arg("--file")
                .arg(&src_path);
            if let Some(u) = cfg.username.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("--username").arg(u);
            }
            if let Some(pw) = secret::read_password(&id)? {
                cmd.env("PGPASSWORD", pw);
            }
            apply_pg_ssl(&mut cmd, &cfg, via_tunnel)?;
            run_tool(cmd, "psql").await?;
        }
        DriverKind::Mysql => {
            let bin = find_binary(&["mysql", "mariadb"]).ok_or_else(|| {
                AppError::msg(
                    "mysql client not found — install it (e.g. `brew install mysql-client`) and retry",
                )
            })?;
            let (host, port) = effective_addr(&state, &cfg)?;
            let via_tunnel = state.tunnels.read().contains_key(&cfg.id);
            let db = cfg
                .database
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::msg("set a database on the connection first"))?;
            let file = std::fs::File::open(&src_path)?;
            let mut cmd = tokio::process::Command::new(bin);
            cmd.arg("--host")
                .arg(&host)
                .arg("--port")
                .arg(port.to_string())
                .arg(db)
                .stdin(std::process::Stdio::from(file));
            if let Some(u) = cfg.username.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("--user").arg(u);
            }
            if let Some(pw) = secret::read_password(&id)? {
                cmd.env("MYSQL_PWD", pw);
            }
            apply_mysql_ssl(&mut cmd, &cfg, via_tunnel)?;
            run_tool(cmd, "mysql").await?;
        }
    }

    Ok(RestoreReport {
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_binary_returns_none_for_nonsense_name() {
        assert!(find_binary(&["rdb-definitely-not-a-real-binary-42"]).is_none());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn find_binary_locates_sh_from_path() {
        // /bin isn't in EXTRA_DIRS, but PATH on any dev/CI box resolves `sh`.
        assert!(find_binary(&["sh"]).is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn find_binary_locates_cmd_with_exe_suffix() {
        // C:\Windows\System32 is always on PATH; probing must append ".exe".
        assert!(find_binary(&["cmd"]).is_some());
    }

    #[test]
    fn tail_of_truncates_long_output() {
        assert_eq!(tail_of("short", 10), "short");
        let long = "x".repeat(50);
        let t = tail_of(&long, 10);
        assert!(t.starts_with('…') && t.len() < 20);
    }

    #[test]
    fn dump_ssl_mode_rejects_verify_full_through_tunnel() {
        let mut cfg = ConnectionConfig {
            id: "c".into(),
            name: "c".into(),
            driver: DriverKind::Postgres,
            host: None,
            port: None,
            database: None,
            username: None,
            file_path: None,
            color: None,
            pinned: false,
            group: None,
            ssl_mode: Some("verify-full".into()),
            read_only: false,
            ssh: None,
            password: None,
        };
        assert!(dump_ssl_mode(&cfg, true).is_err());
        assert_eq!(
            dump_ssl_mode(&cfg, false).unwrap(),
            Some(SslMode::VerifyFull)
        );
        cfg.ssl_mode = Some("require".into());
        assert_eq!(dump_ssl_mode(&cfg, false).unwrap(), Some(SslMode::Require));
        cfg.ssl_mode = Some("disable".into());
        assert_eq!(dump_ssl_mode(&cfg, false).unwrap(), Some(SslMode::Disable));
    }
}
