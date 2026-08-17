pub mod pool;
pub mod meta;
pub mod exec;
pub mod data;
pub mod design;
pub mod io;
pub mod alter;
pub mod redis_ops;
pub mod ssh;

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, DriverKind};

pub fn build_url(cfg: &ConnectionConfig) -> AppResult<String> {
    build_url_with(cfg, None)
}

/// The DB host/port a tunnel should forward to (from the SSH server's view),
/// applying driver defaults. Not meaningful for SQLite.
fn nonempty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

pub fn target_addr(cfg: &ConnectionConfig) -> (String, u16) {
    let host = nonempty(cfg.host.as_deref())
        .unwrap_or("localhost")
        .to_string();
    let port = cfg
        .port
        .or_else(|| cfg.driver.default_port())
        .unwrap_or(0);
    (host, port)
}

/// Normalized TLS mode. `verify` controls whether the server certificate and
/// hostname are checked; when `None` the connection is plaintext.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SslMode {
    Require,
    VerifyFull,
}

pub fn ssl_mode_of(cfg: &ConnectionConfig) -> Option<SslMode> {
    match cfg.ssl_mode.as_deref().map(str::trim) {
        Some("require") => Some(SslMode::Require),
        Some("verify-full") | Some("verify_full") => Some(SslMode::VerifyFull),
        _ => None,
    }
}

/// Build a connection URL. When `addr_override` is set (an SSH tunnel's local
/// endpoint) it replaces the configured host/port, and certificate hostname
/// verification is relaxed to "require" since the client is dialing localhost.
pub fn build_url_with(
    cfg: &ConnectionConfig,
    addr_override: Option<(&str, u16)>,
) -> AppResult<String> {
    // Through a tunnel we connect to 127.0.0.1, so a cert's hostname can never
    // match — downgrade verify-full to encrypt-only there.
    let ssl = match (ssl_mode_of(cfg), addr_override.is_some()) {
        (Some(SslMode::VerifyFull), true) => Some(SslMode::Require),
        (other, _) => other,
    };
    match cfg.driver {
        DriverKind::Sqlite => {
            let path = nonempty(cfg.file_path.as_deref())
                .or_else(|| nonempty(cfg.database.as_deref()))
                .ok_or_else(|| AppError::msg("SQLite requires a file path"))?;
            Ok(sqlite_connect_url(path))
        }
        DriverKind::Postgres => {
            let (host, port) = addr_override.unwrap_or_else(|| {
                (
                    nonempty(cfg.host.as_deref()).unwrap_or("localhost"),
                    cfg.port.unwrap_or(5432),
                )
            });
            let db = nonempty(cfg.database.as_deref()).unwrap_or("postgres");
            let user = nonempty(cfg.username.as_deref())
                .ok_or_else(|| AppError::msg("Postgres requires a username"))?;
            let pw = cfg.password.as_deref().unwrap_or("");
            let mut url = format!(
                "postgres://{}:{}@{}:{}/{}",
                url_enc(user),
                url_enc(pw),
                host,
                port,
                url_enc(db)
            );
            if let Some(mode) = ssl {
                let v = match mode {
                    SslMode::Require => "require",
                    SslMode::VerifyFull => "verify-full",
                };
                url.push_str("?sslmode=");
                url.push_str(v);
            }
            Ok(url)
        }
        DriverKind::Mysql => {
            let (host, port) = addr_override.unwrap_or_else(|| {
                (
                    nonempty(cfg.host.as_deref()).unwrap_or("localhost"),
                    cfg.port.unwrap_or(3306),
                )
            });
            let db = nonempty(cfg.database.as_deref()).unwrap_or("");
            let user = nonempty(cfg.username.as_deref())
                .ok_or_else(|| AppError::msg("MySQL requires a username"))?;
            let pw = cfg.password.as_deref().unwrap_or("");
            let mut url = format!(
                "mysql://{}:{}@{}:{}/{}",
                url_enc(user),
                url_enc(pw),
                host,
                port,
                url_enc(db)
            );
            if let Some(mode) = ssl {
                let v = match mode {
                    SslMode::Require => "REQUIRED",
                    SslMode::VerifyFull => "VERIFY_IDENTITY",
                };
                url.push_str("?ssl-mode=");
                url.push_str(v);
            }
            Ok(url)
        }
        DriverKind::Redis => {
            let (host, port) = addr_override.unwrap_or_else(|| {
                (
                    nonempty(cfg.host.as_deref()).unwrap_or("localhost"),
                    cfg.port.unwrap_or(6379),
                )
            });
            // ACL user (Redis 6+) goes in the userinfo segment; legacy
            // `requirepass`-only servers use empty user with the password.
            let user = nonempty(cfg.username.as_deref()).unwrap_or("");
            let pw = cfg.password.as_deref().unwrap_or("");
            // `database` field doubles as the numeric DB index (0..15 by default).
            let db_idx: u8 = nonempty(cfg.database.as_deref())
                .map(|s| s.parse::<u8>())
                .transpose()
                .map_err(|_| AppError::msg("Redis database must be an integer (0..15)"))?
                .unwrap_or(0);
            let auth = if user.is_empty() && pw.is_empty() {
                String::new()
            } else {
                format!("{}:{}@", url_enc(user), url_enc(pw))
            };
            // rediss:// negotiates TLS; "#insecure" skips cert verification.
            let (scheme, frag) = match ssl {
                None => ("redis", ""),
                Some(SslMode::Require) => ("rediss", "#insecure"),
                Some(SslMode::VerifyFull) => ("rediss", ""),
            };
            Ok(format!("{}://{}{}:{}/{}{}", scheme, auth, host, port, db_idx, frag))
        }
    }
}

/// sqlx URL for a filesystem path. Windows backslashes become `/`, drive
/// letters get the extra slash (`sqlite:///C:/…`) so the URL parser does not
/// treat `C` as a host, and `?`/`#` in the path are percent-encoded so they
/// cannot steal the query string.
fn sqlite_connect_url(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let drive_abs = normalized.len() >= 2
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && normalized.as_bytes()[1] == b':';
    let encoded = encode_sqlite_path(&normalized);
    if drive_abs {
        format!("sqlite:///{}?mode=rwc", encoded)
    } else {
        format!("sqlite://{}?mode=rwc", encoded)
    }
}

fn encode_sqlite_path(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for b in p.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'/'
            | b':'
            | b'.'
            | b'-'
            | b'_'
            | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn url_enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ConnectionConfig, DriverKind};

    fn base_cfg(driver: DriverKind) -> ConnectionConfig {
        ConnectionConfig {
            id: "id".into(),
            name: "name".into(),
            driver,
            host: None,
            port: None,
            database: None,
            username: None,
            file_path: None,
            color: None,
            pinned: false,
            group: None,
            ssl_mode: None,
            read_only: false,
            ssh: None,
            password: None,
        }
    }

    #[test]
    fn url_enc_preserves_ascii_safe() {
        assert_eq!(url_enc("abcXYZ_0-9.~"), "abcXYZ_0-9.~");
    }

    #[test]
    fn build_url_postgres_sslmode_require() {
        let mut c = base_cfg(DriverKind::Postgres);
        c.username = Some("u".into());
        c.ssl_mode = Some("require".into());
        let url = build_url(&c).unwrap();
        assert!(url.ends_with("?sslmode=require"), "{url}");
    }

    #[test]
    fn build_url_mysql_sslmode_verify_full() {
        let mut c = base_cfg(DriverKind::Mysql);
        c.username = Some("u".into());
        c.ssl_mode = Some("verify-full".into());
        let url = build_url(&c).unwrap();
        assert!(url.ends_with("?ssl-mode=VERIFY_IDENTITY"), "{url}");
    }

    #[test]
    fn build_url_redis_require_uses_rediss_insecure() {
        let mut c = base_cfg(DriverKind::Redis);
        c.ssl_mode = Some("require".into());
        let url = build_url(&c).unwrap();
        assert!(url.starts_with("rediss://"), "{url}");
        assert!(url.ends_with("#insecure"), "{url}");
    }

    #[test]
    fn build_url_disable_is_plaintext() {
        let mut c = base_cfg(DriverKind::Postgres);
        c.username = Some("u".into());
        c.ssl_mode = Some("disable".into());
        assert!(!build_url(&c).unwrap().contains("sslmode"));
    }

    #[test]
    fn build_url_tunnel_override_relaxes_verify_full() {
        let mut c = base_cfg(DriverKind::Postgres);
        c.username = Some("u".into());
        c.host = Some("db.internal".into());
        c.ssl_mode = Some("verify-full".into());
        let url = build_url_with(&c, Some(("127.0.0.1", 54321))).unwrap();
        assert!(url.contains("@127.0.0.1:54321/"), "{url}");
        assert!(url.ends_with("?sslmode=require"), "{url}");
    }

    #[test]
    fn url_enc_encodes_special_bytes() {
        assert_eq!(url_enc("a@b"), "a%40b");
        assert_eq!(url_enc(":"), "%3A");
        assert_eq!(url_enc(" "), "%20");
    }

    #[test]
    fn build_url_sqlite_file_path() {
        let mut c = base_cfg(DriverKind::Sqlite);
        c.file_path = Some("/tmp/foo.db".into());
        let url = build_url(&c).unwrap();
        assert_eq!(url, "sqlite:///tmp/foo.db?mode=rwc");
    }

    #[test]
    fn build_url_sqlite_fallback_to_database() {
        let mut c = base_cfg(DriverKind::Sqlite);
        c.database = Some("/tmp/bar.db".into());
        let url = build_url(&c).unwrap();
        assert_eq!(url, "sqlite:///tmp/bar.db?mode=rwc");
    }

    #[test]
    fn build_url_sqlite_missing_path_errors() {
        let c = base_cfg(DriverKind::Sqlite);
        assert!(build_url(&c).is_err());
    }

    #[test]
    fn build_url_sqlite_empty_path_errors() {
        let mut c = base_cfg(DriverKind::Sqlite);
        c.file_path = Some("".into());
        c.database = Some("   ".into());
        assert!(build_url(&c).is_err());
    }

    #[test]
    fn sqlite_connect_url_windows_drive_and_backslashes() {
        assert_eq!(
            sqlite_connect_url(r"C:\Users\foo\bar.db"),
            "sqlite:///C:/Users/foo/bar.db?mode=rwc"
        );
        assert_eq!(
            sqlite_connect_url("C:/Users/foo/bar.db"),
            "sqlite:///C:/Users/foo/bar.db?mode=rwc"
        );
    }

    #[test]
    fn sqlite_connect_url_encodes_query_metachars() {
        assert_eq!(
            sqlite_connect_url("/tmp/foo?bar.db"),
            "sqlite:///tmp/foo%3Fbar.db?mode=rwc"
        );
    }

    #[test]
    fn build_url_postgres_empty_username_errors() {
        let mut c = base_cfg(DriverKind::Postgres);
        c.username = Some("".into());
        assert!(build_url(&c).is_err());
    }

    #[test]
    fn build_url_postgres_defaults() {
        let mut c = base_cfg(DriverKind::Postgres);
        c.username = Some("me".into());
        let url = build_url(&c).unwrap();
        // default port 5432, default host localhost, default db postgres
        assert_eq!(url, "postgres://me:@localhost:5432/postgres");
    }

    #[test]
    fn build_url_postgres_full() {
        let mut c = base_cfg(DriverKind::Postgres);
        c.host = Some("db.example.com".into());
        c.port = Some(6543);
        c.database = Some("mydb".into());
        c.username = Some("me".into());
        c.password = Some("secret".into());
        let url = build_url(&c).unwrap();
        assert_eq!(url, "postgres://me:secret@db.example.com:6543/mydb");
    }

    #[test]
    fn build_url_postgres_url_encodes_username_specials() {
        let mut c = base_cfg(DriverKind::Postgres);
        c.username = Some("a@b".into());
        c.password = Some("p:w".into());
        let url = build_url(&c).unwrap();
        assert!(url.contains("a%40b"));
        assert!(url.contains("p%3Aw"));
    }

    #[test]
    fn build_url_postgres_missing_username_errors() {
        let c = base_cfg(DriverKind::Postgres);
        assert!(build_url(&c).is_err());
    }

    #[test]
    fn build_url_mysql_defaults() {
        let mut c = base_cfg(DriverKind::Mysql);
        c.username = Some("root".into());
        let url = build_url(&c).unwrap();
        assert_eq!(url, "mysql://root:@localhost:3306/");
    }

    #[test]
    fn build_url_mysql_missing_username_errors() {
        let c = base_cfg(DriverKind::Mysql);
        assert!(build_url(&c).is_err());
    }

    #[test]
    fn build_url_redis_defaults_no_auth() {
        let c = base_cfg(DriverKind::Redis);
        assert_eq!(build_url(&c).unwrap(), "redis://localhost:6379/0");
    }

    #[test]
    fn build_url_redis_password_only_legacy() {
        let mut c = base_cfg(DriverKind::Redis);
        c.password = Some("secret".into());
        // Legacy `requirepass`: empty user, password in URL userinfo.
        assert_eq!(build_url(&c).unwrap(), "redis://:secret@localhost:6379/0");
    }

    #[test]
    fn build_url_redis_acl_user_password_and_db() {
        let mut c = base_cfg(DriverKind::Redis);
        c.host = Some("cache.local".into());
        c.port = Some(6380);
        c.username = Some("acluser".into());
        c.password = Some("p@ss".into());
        c.database = Some("3".into());
        let url = build_url(&c).unwrap();
        assert_eq!(url, "redis://acluser:p%40ss@cache.local:6380/3");
    }

    #[test]
    fn build_url_redis_invalid_db_index_errors() {
        let mut c = base_cfg(DriverKind::Redis);
        c.database = Some("not-a-number".into());
        assert!(build_url(&c).is_err());
    }
}
