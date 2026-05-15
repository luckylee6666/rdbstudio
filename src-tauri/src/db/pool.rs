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
}

impl RedisHandle {
    pub fn new(mgr: ConnectionManager) -> Self {
        Self { inner: Arc::new(Mutex::new(mgr)) }
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
                let mgr = ConnectionManager::new(client).await?;
                Ok(Self::Redis(RedisHandle::new(mgr)))
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
