pub mod pool;
pub mod meta;
pub mod exec;
pub mod data;
pub mod design;
pub mod io;
pub mod alter;
pub mod redis_ops;

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, DriverKind};

pub fn build_url(cfg: &ConnectionConfig) -> AppResult<String> {
    match cfg.driver {
        DriverKind::Sqlite => {
            let path = cfg
                .file_path
                .as_deref()
                .or(cfg.database.as_deref())
                .ok_or_else(|| AppError::msg("SQLite requires a file path"))?;
            Ok(format!("sqlite://{}?mode=rwc", path))
        }
        DriverKind::Postgres => {
            let host = cfg.host.as_deref().unwrap_or("localhost");
            let port = cfg.port.unwrap_or(5432);
            let db = cfg.database.as_deref().unwrap_or("postgres");
            let user = cfg
                .username
                .as_deref()
                .ok_or_else(|| AppError::msg("Postgres requires a username"))?;
            let pw = cfg.password.as_deref().unwrap_or("");
            Ok(format!(
                "postgres://{}:{}@{}:{}/{}",
                url_enc(user),
                url_enc(pw),
                host,
                port,
                url_enc(db)
            ))
        }
        DriverKind::Mysql => {
            let host = cfg.host.as_deref().unwrap_or("localhost");
            let port = cfg.port.unwrap_or(3306);
            let db = cfg.database.as_deref().unwrap_or("");
            let user = cfg
                .username
                .as_deref()
                .ok_or_else(|| AppError::msg("MySQL requires a username"))?;
            let pw = cfg.password.as_deref().unwrap_or("");
            Ok(format!(
                "mysql://{}:{}@{}:{}/{}",
                url_enc(user),
                url_enc(pw),
                host,
                port,
                url_enc(db)
            ))
        }
        DriverKind::Redis => {
            let host = cfg.host.as_deref().unwrap_or("localhost");
            let port = cfg.port.unwrap_or(6379);
            // ACL user (Redis 6+) goes in the userinfo segment; legacy
            // `requirepass`-only servers use empty user with the password.
            let user = cfg.username.as_deref().unwrap_or("");
            let pw = cfg.password.as_deref().unwrap_or("");
            // `database` field doubles as the numeric DB index (0..15 by default).
            let db_idx: u8 = cfg
                .database
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| s.parse::<u8>())
                .transpose()
                .map_err(|_| AppError::msg("Redis database must be an integer (0..15)"))?
                .unwrap_or(0);
            let auth = if user.is_empty() && pw.is_empty() {
                String::new()
            } else {
                format!("{}:{}@", url_enc(user), url_enc(pw))
            };
            Ok(format!("redis://{}{}:{}/{}", auth, host, port, db_idx))
        }
    }
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
            password: None,
        }
    }

    #[test]
    fn url_enc_preserves_ascii_safe() {
        assert_eq!(url_enc("abcXYZ_0-9.~"), "abcXYZ_0-9.~");
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
