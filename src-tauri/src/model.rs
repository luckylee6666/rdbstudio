use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Sqlite,
    Postgres,
    Mysql,
    Redis,
}

impl DriverKind {
    pub fn default_port(self) -> Option<u16> {
        match self {
            DriverKind::Sqlite => None,
            DriverKind::Postgres => Some(5432),
            DriverKind::Mysql => Some(3306),
            DriverKind::Redis => Some(6379),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub driver: DriverKind,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    /// Optional; for SQLite a filesystem path is expected here or in `database`.
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    /// Optional group label for the sidebar. Empty/None = ungrouped.
    /// Single-level only; the UI does not nest groups.
    #[serde(default)]
    pub group: Option<String>,
    /// Transient: present on save/test requests, never persisted to disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeEntry {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Redis-only: PTTL in milliseconds. -1 means no expiration, missing means
    /// not applicable (SQL tables/views never set this).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionSummary {
    pub id: String,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
}
