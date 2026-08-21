use crate::error::AppResult;
use crate::model::DriverKind;
use parking_lot::Mutex;
use redis::aio::ConnectionManager;
use sqlx::{mysql::MySqlPoolOptions, postgres::PgPoolOptions, sqlite::SqlitePoolOptions};
use sqlx::{MySqlPool, PgPool, SqlitePool};
use std::sync::Arc;
use std::time::Duration;

/// Wraps the redis ConnectionManager behind an interior-mutable handle so
/// commands can grab a mutable connection clone without &mut DbPool.
#[derive(Clone)]
pub struct RedisHandle {
    inner: Arc<Mutex<ConnectionManager>>,
    /// DB index selected at connect time (`/N` in the redis URL).
    pub db_index: u8,
}

impl RedisHandle {
    pub fn new(mgr: ConnectionManager, db_index: u8) -> Self {
        Self {
            inner: Arc::new(Mutex::new(mgr)),
            db_index,
        }
    }
    /// Cheap clone of the underlying multiplexed connection — every clone
    /// shares the same TCP session, so commands are pipelined safely.
    pub fn conn(&self) -> ConnectionManager {
        self.inner.lock().clone()
    }
}

#[derive(Clone)]
pub enum DbPool {
    Sqlite(SqlitePool),
    Postgres(PgPool),
    Mysql(MySqlPool),
    Redis(RedisHandle),
}

impl DbPool {
    pub fn driver(&self) -> DriverKind {
        match self {
            Self::Sqlite(_) => DriverKind::Sqlite,
            Self::Postgres(_) => DriverKind::Postgres,
            Self::Mysql(_) => DriverKind::Mysql,
            Self::Redis(_) => DriverKind::Redis,
        }
    }

    pub async fn connect(driver: DriverKind, url: &str) -> AppResult<Self> {
        match driver {
            DriverKind::Sqlite => {
                let pool = SqlitePoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(Duration::from_secs(10))
                    .connect(url)
                    .await?;
                // Without this, concurrent readers + a writer surface
                // SQLITE_BUSY immediately instead of waiting out the lock.
                sqlx::query("PRAGMA busy_timeout = 5000")
                    .execute(&pool)
                    .await?;
                Ok(Self::Sqlite(pool))
            }
            DriverKind::Postgres => {
                let pool = PgPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(Duration::from_secs(10))
                    .connect(url)
                    .await?;
                Ok(Self::Postgres(pool))
            }
            DriverKind::Mysql => {
                let pool = MySqlPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(Duration::from_secs(10))
                    .connect(url)
                    .await?;
                Ok(Self::Mysql(pool))
            }
            DriverKind::Redis => {
                let client = redis::Client::open(url)?;
                let mgr =
                    tokio::time::timeout(Duration::from_secs(10), ConnectionManager::new(client))
                        .await
                        .map_err(|_| {
                            crate::error::AppError::msg(
                                "Redis connection timed out after 10 seconds",
                            )
                        })??;
                Ok(Self::Redis(RedisHandle::new(mgr, redis_db_index(url))))
            }
        }
    }

    pub async fn close(&self) {
        match self {
            Self::Sqlite(p) => p.close().await,
            Self::Postgres(p) => p.close().await,
            Self::Mysql(p) => p.close().await,
            // ConnectionManager has no explicit close; dropping is enough.
            Self::Redis(_) => {}
        }
    }
}

fn redis_db_index(url: &str) -> u8 {
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = after_scheme.split_once('/').map(|(_, p)| p).unwrap_or("");
    let num = path.split(['?', '#']).next().unwrap_or("");
    num.parse().unwrap_or(0)
}
