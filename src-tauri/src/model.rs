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
    /// TLS mode for PG/MySQL/Redis. None/"disable" = plaintext (default),
    /// "require" = encrypted without cert verification, "verify-full" =
    /// encrypted + verify server cert/hostname against system roots.
    /// Ignored for SQLite.
    #[serde(default)]
    pub ssl_mode: Option<String>,
    /// Optional SSH tunnel; when present, connections route through it.
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// Transient: present on save/test requests, never persisted to disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

/// SSH tunnel settings. The DB host/port in the parent config are resolved
/// *from the SSH server's perspective* and forwarded to a local random port.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    /// "password" or "key".
    #[serde(default)]
    pub auth: Option<String>,
    /// Path to a private key file (auth = "key").
    #[serde(default)]
    pub key_path: Option<String>,
    /// Transient: SSH password or key passphrase. Stored in the keychain under
    /// "<id>::ssh", never persisted to the JSON config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub description: Option<String>,
}

