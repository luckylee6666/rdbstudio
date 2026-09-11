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
use tokio_util::sync::CancellationToken;

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
        // Byte slicing can land inside a multi-byte character (localized
        // stderr, for example) and panic; step forward to a char boundary.
        let mut start = t.len() - max;
        while start < t.len() && !t.is_char_boundary(start) {
            start += 1;
        }
        format!("…{}", &t[start..])
    }
}

fn mysql_database(cfg: &ConnectionConfig) -> Option<&str> {
    cfg.database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// A connection created without a default database represents the whole MySQL
/// server in the tree. Dump all databases in that case instead of rejecting the
/// root-level "Dump Database" action.
fn apply_mysql_dump_scope(cmd: &mut tokio::process::Command, database: Option<&str>) {
    match database {
        Some(database) => {
            // --databases preserves CREATE DATABASE / USE statements and also
            // makes a database name beginning with '-' unambiguous.
            cmd.arg("--databases").arg(database);
        }
        None => {
            cmd.arg("--all-databases");
        }
    }
}

fn apply_pg_dump_scope(cmd: &mut tokio::process::Command, schema: Option<&str>, schema_only: bool) {
    if let Some(schema) = schema {
        cmd.arg("--schema").arg(schema);
    }
    if schema_only {
        cmd.arg("--schema-only");
    }
}

async fn dump_sqlite_schema(pool: &sqlx::SqlitePool, dest_path: &str) -> AppResult<()> {
    let statements = sqlx::query_scalar::<_, String>(
        "SELECT sql FROM sqlite_master \
         WHERE sql IS NOT NULL \
           AND name NOT LIKE 'sqlite_%' \
           AND type IN ('table', 'index', 'trigger', 'view') \
         ORDER BY CASE type \
           WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name",
    )
    .fetch_all(pool)
    .await?;
    let mut sql = String::from("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n");
    for statement in statements {
        sql.push_str(statement.trim_end_matches(';'));
        sql.push_str(";\n\n");
    }
    sql.push_str("COMMIT;\n");
    std::fs::write(dest_path, sql)?;
    Ok(())
}

/// Every SQLite database file starts with these 16 bytes.
const SQLITE_HEADER: [u8; 16] = *b"SQLite format 3\0";

/// Restore a SQLite database by replacing `target` with the file at `src`.
///
/// The source is validated first (SQLite header) and the copy lands in a
/// sibling temp file before being renamed over the target, so a failed or
/// interrupted copy never leaves a truncated database behind.
pub fn restore_sqlite_file(target: &Path, src: &Path) -> AppResult<()> {
    use std::io::{Read, Seek, SeekFrom};

    let mut source = std::fs::File::open(src)
        .map_err(|e| AppError::msg(format!("cannot open backup file {}: {e}", src.display())))?;
    let mut header = [0u8; 16];
    if source.read_exact(&mut header).is_err() {
        return Err(AppError::msg(format!(
            "{} is not a SQLite database (file is too short)",
            src.display()
        )));
    }
    if header != SQLITE_HEADER {
        return Err(AppError::msg(format!(
            "{} is not a SQLite database (missing \"SQLite format 3\" header)",
            src.display()
        )));
    }
    source.seek(SeekFrom::Start(0))?;

    let parent = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    std::fs::create_dir_all(parent)?;

    // Same directory as the target: the temp file stays on one filesystem so
    // the final rename is a single atomic operation.
    let tmp = parent.join(format!(".rdbstudio-restore-{}.tmp", uuid::Uuid::new_v4()));
    let copied = (|| -> std::io::Result<()> {
        let mut out = std::fs::File::create(&tmp)?;
        std::io::copy(&mut source, &mut out)?;
        out.sync_all()?;
        Ok(())
    })();
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::msg(format!(
            "failed to stage the restore in {}: {e}",
            tmp.display()
        )));
    }

    if let Err(e) = replace_file(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::msg(format!(
            "failed to replace {}: {e}",
            target.display()
        )));
    }

    // Pooled SQLite connections run in WAL mode. A stale write-ahead log next
    // to the freshly restored main file could replay pre-restore frames, so
    // drop the sidecars once the main file has been swapped.
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = target.as_os_str().to_os_string();
        sidecar.push(suffix);
        match std::fs::remove_file(Path::new(&sidecar)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(AppError::msg(format!(
                    "restored {}, but could not remove {}: {e}",
                    target.display(),
                    Path::new(&sidecar).display()
                )))
            }
        }
    }
    Ok(())
}

/// Rename `tmp` over `target`. Unix replaces atomically; Windows refuses to
/// rename onto an existing file, so remove the old database and retry (the
/// staged copy is already complete at this point).
fn replace_file(tmp: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::rename(tmp, target) {
        Ok(()) => Ok(()),
        Err(first) => {
            #[cfg(target_os = "windows")]
            if target.exists() {
                std::fs::remove_file(target)?;
                return std::fs::rename(tmp, target);
            }
            Err(first)
        }
    }
}

/// Registers a cancellable IO operation for as long as the guard lives and
/// clears it on drop, so early returns cannot leak the entry (and a leaked id
/// would block a retry).
struct IoOpGuard<'a> {
    state: &'a AppState,
    op_id: Option<String>,
}

impl<'a> IoOpGuard<'a> {
    fn begin(
        state: &'a AppState,
        operation_id: Option<String>,
    ) -> AppResult<(Self, Option<CancellationToken>)> {
        match operation_id {
            Some(op_id) => {
                let token = CancellationToken::new();
                if !state.begin_io_op(&op_id, token.clone()) {
                    return Err(AppError::msg("operation id is already in use"));
                }
                Ok((
                    Self {
                        state,
                        op_id: Some(op_id),
                    },
                    Some(token),
                ))
            }
            None => Ok((Self { state, op_id: None }, None)),
        }
    }
}

impl Drop for IoOpGuard<'_> {
    fn drop(&mut self) {
        if let Some(op_id) = self.op_id.take() {
            self.state.finish_io_op(&op_id);
        }
    }
}

async fn run_tool(
    mut cmd: tokio::process::Command,
    tool: &str,
    cancel: Option<CancellationToken>,
) -> AppResult<()> {
    use tokio::io::AsyncReadExt;

    // Capture output while the process runs: waiting without draining a full
    // pipe would deadlock, and a cancel needs to distinguish "killed by the
    // button" from "tool failed".
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("failed to launch {tool}: {e}")))?;
    let mut child_stdout = child.stdout.take().expect("stdout is piped");
    let mut child_stderr = child.stderr.take().expect("stderr is piped");
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = child_stdout.read_to_end(&mut buf).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = child_stderr.read_to_end(&mut buf).await;
        buf
    });

    let status = match &cancel {
        Some(token) => tokio::select! {
            status = child.wait() => Some(status),
            _ = token.cancelled() => None,
        },
        None => Some(child.wait().await),
    };

    let Some(status) = status else {
        // Killing closes the pipes and lets the drain tasks finish; reap the
        // child so no zombie is left behind.
        let _ = child.start_kill();
        let _ = child.wait().await;
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        return Err(AppError::msg(format!("{tool} cancelled")));
    };

    let status = status.map_err(|e| AppError::msg(format!("failed to wait for {tool}: {e}")))?;
    let stderr = stderr_task.await.unwrap_or_default();
    let _ = stdout_task.await;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        return Err(AppError::msg(format!(
            "{tool} exited with {}: {}",
            status,
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
    database: Option<String>,
    schema_only: bool,
    operation_id: Option<String>,
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
            if let Some(database) = database.as_deref() {
                if database != "main" {
                    return Err(AppError::msg("SQLite only supports the main database"));
                }
            }
            if schema_only {
                dump_sqlite_schema(p, &dest_path).await?;
            } else {
                // VACUUM INTO refuses to overwrite; the save dialog already asked.
                if Path::new(&dest_path).exists() {
                    std::fs::remove_file(&dest_path)?;
                }
                let sql = format!("VACUUM INTO '{}'", dest_path.replace('\'', "''"));
                sqlx::query(&sql).execute(p).await?;
            }
        }
        DriverKind::Postgres => {
            let (_io_guard, cancel) = IoOpGuard::begin(&state, operation_id)?;
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
            apply_pg_dump_scope(&mut cmd, database.as_deref(), schema_only);
            if let Some(u) = cfg.username.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("--username").arg(u);
            }
            if let Some(pw) = secret::read_password(&id)? {
                cmd.env("PGPASSWORD", pw);
            }
            apply_pg_ssl(&mut cmd, &cfg, via_tunnel)?;
            run_tool(cmd, "pg_dump", cancel).await?;
        }
        DriverKind::Mysql => {
            let (_io_guard, cancel) = IoOpGuard::begin(&state, operation_id)?;
            let bin = find_binary(&["mysqldump", "mariadb-dump"]).ok_or_else(|| {
                AppError::msg(
                    "mysqldump not found — install it (e.g. `brew install mysql-client`) and retry",
                )
            })?;
            let (host, port) = effective_addr(&state, &cfg)?;
            let via_tunnel = state.tunnels.read().contains_key(&cfg.id);
            let mut cmd = tokio::process::Command::new(bin);
            cmd.arg("--host")
                .arg(&host)
                .arg("--port")
                .arg(port.to_string())
                .arg("--single-transaction")
                .arg("--routines")
                .arg("--result-file")
                .arg(&dest_path);
            if schema_only {
                cmd.arg("--no-data");
            }
            apply_mysql_dump_scope(
                &mut cmd,
                database.as_deref().or_else(|| mysql_database(&cfg)),
            );
            if let Some(u) = cfg.username.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("--user").arg(u);
            }
            if let Some(pw) = secret::read_password(&id)? {
                cmd.env("MYSQL_PWD", pw);
            }
            apply_mysql_ssl(&mut cmd, &cfg, via_tunnel)?;
            run_tool(cmd, "mysqldump", cancel).await?;
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
    operation_id: Option<String>,
) -> AppResult<RestoreReport> {
    crate::commands::ensure_writable(&state, &id)?;
    let cfg = state
        .store
        .get(&id)
        .ok_or_else(|| AppError::msg("unknown connection"))?;
    if !Path::new(&src_path).is_file() {
        return Err(AppError::msg("backup file not found"));
    }
    let start = std::time::Instant::now();

    match cfg.driver {
        DriverKind::Sqlite => {
            // A binary dump replaces the database file itself, so the pool
            // must be closed first: SQLite would keep serving (and writing)
            // the old inode after the rename.
            if state.get_pool(&id).is_some() {
                return Err(AppError::msg(
                    "disconnect the connection before restoring over its file: \
                     use Disconnect in the connection menu, then run Restore again",
                ));
            }
            let target = cfg
                .file_path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| AppError::msg("this SQLite connection has no database file"))?;
            restore_sqlite_file(Path::new(target), Path::new(&src_path))?;
        }
        DriverKind::Redis => return Err(AppError::msg("restore is not supported for Redis")),
        DriverKind::Postgres => {
            let (_io_guard, cancel) = IoOpGuard::begin(&state, operation_id)?;
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
            run_tool(cmd, "psql", cancel).await?;
        }
        DriverKind::Mysql => {
            let (_io_guard, cancel) = IoOpGuard::begin(&state, operation_id)?;
            let bin = find_binary(&["mysql", "mariadb"]).ok_or_else(|| {
                AppError::msg(
                    "mysql client not found — install it (e.g. `brew install mysql-client`) and retry",
                )
            })?;
            let (host, port) = effective_addr(&state, &cfg)?;
            let via_tunnel = state.tunnels.read().contains_key(&cfg.id);
            let file = std::fs::File::open(&src_path)?;
            let mut cmd = tokio::process::Command::new(bin);
            cmd.arg("--host")
                .arg(&host)
                .arg("--port")
                .arg(port.to_string())
                .stdin(std::process::Stdio::from(file));
            if let Some(database) = mysql_database(&cfg) {
                cmd.arg(database);
            }
            if let Some(u) = cfg.username.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("--user").arg(u);
            }
            if let Some(pw) = secret::read_password(&id)? {
                cmd.env("MYSQL_PWD", pw);
            }
            apply_mysql_ssl(&mut cmd, &cfg, via_tunnel)?;
            run_tool(cmd, "mysql", cancel).await?;
        }
    }

    Ok(RestoreReport {
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

/// Cancel an in-flight dump/restore by the operation id the frontend passed
/// to `dump_database` / `restore_database`. Returns whether a live operation
/// was found; SQLite snapshots have no child process, so they always report
/// `false` here.
#[tauri::command]
pub fn cancel_db_io(state: State<'_, AppState>, operation_id: String) -> bool {
    state.cancel_io_op(&operation_id)
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

    #[test]
    fn mysql_dump_without_default_database_uses_all_databases() {
        let mut cmd = tokio::process::Command::new("mysqldump");
        apply_mysql_dump_scope(&mut cmd, None);
        let args: Vec<_> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["--all-databases"]);
    }

    #[test]
    fn mysql_dump_with_default_database_keeps_single_database_scope() {
        let mut cmd = tokio::process::Command::new("mysqldump");
        apply_mysql_dump_scope(&mut cmd, Some("app"));
        let args: Vec<_> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["--databases", "app"]);
    }

    #[test]
    fn postgres_single_schema_dump_can_be_structure_only() {
        let mut cmd = tokio::process::Command::new("pg_dump");
        apply_pg_dump_scope(&mut cmd, Some("public"), true);
        let args: Vec<_> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["--schema", "public", "--schema-only"]);
    }

    #[tokio::test]
    async fn sqlite_structure_only_dump_omits_table_rows() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (name) VALUES ('secret-row')")
            .execute(&pool)
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("schema.sql");

        dump_sqlite_schema(&pool, path.to_str().unwrap())
            .await
            .unwrap();

        let sql = std::fs::read_to_string(path).unwrap();
        assert!(sql.contains("CREATE TABLE users"));
        assert!(!sql.contains("secret-row"));
        assert!(!sql.contains("INSERT INTO"));
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
    fn tail_of_cuts_on_a_char_boundary() {
        // Localized tool output is multi-byte; slicing at a byte offset used
        // to panic when it landed mid-character.
        let msg = "错误信息重复出现".repeat(20);
        let t = tail_of(&msg, 10);
        assert!(t.starts_with('…'));
        assert!(t.ends_with("出现"));
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
