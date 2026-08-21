use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, DriverKind, SshConfig};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

const MAX_NCX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 1_000;
const MAX_ATTRIBUTE_BYTES: usize = 16 * 1024;

#[derive(Debug, Serialize)]
pub struct NavicatImportPreview {
    pub connections: Vec<ConnectionConfig>,
    pub source_count: usize,
    pub unsupported_types: Vec<String>,
    pub password_count: usize,
    pub ssh_password_count: usize,
    pub http_tunnel_count: usize,
    pub unsupported_ssl_count: usize,
}

#[derive(Default)]
struct PreviewStats {
    source_count: usize,
    unsupported_types: BTreeSet<String>,
    password_count: usize,
    ssh_password_count: usize,
    http_tunnel_count: usize,
    unsupported_ssl_count: usize,
}

/// Parse a Navicat `.ncx` export into connection candidates. Passwords are
/// intentionally ignored: Navicat exports an encrypted vendor-specific value,
/// and importing it as plaintext would create a broken keychain entry.
#[tauri::command]
pub fn preview_navicat_connections(path: String) -> AppResult<NavicatImportPreview> {
    let path = Path::new(&path);
    let is_ncx = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("ncx"))
        .unwrap_or(false);
    if !is_ncx {
        return Err(AppError::msg(
            "Navicat connection export must be an .ncx file",
        ));
    }

    // Open once, then validate and read through the same handle. Checking path
    // metadata and calling `read(path)` separately would allow a file in a
    // shared directory to be swapped between the two operations.
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::msg("Navicat import path is not a file"));
    }
    if metadata.len() > MAX_NCX_BYTES {
        return Err(AppError::msg(format!(
            "Navicat export is too large (maximum {} MiB)",
            MAX_NCX_BYTES / 1024 / 1024
        )));
    }

    // Keep the limit authoritative even when the file grows after metadata was
    // read or its reported size is inaccurate (for example a virtual file).
    let mut xml = Vec::with_capacity(metadata.len().min(MAX_NCX_BYTES) as usize);
    file.take(MAX_NCX_BYTES + 1).read_to_end(&mut xml)?;
    if xml.len() as u64 > MAX_NCX_BYTES {
        return Err(AppError::msg(format!(
            "Navicat export is too large (maximum {} MiB)",
            MAX_NCX_BYTES / 1024 / 1024
        )));
    }
    parse_navicat_xml(&xml)
}

fn parse_navicat_xml(xml: &[u8]) -> AppResult<NavicatImportPreview> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut connections = Vec::new();
    let mut stats = PreviewStats::default();
    let mut saw_root = false;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if element.name().as_ref() == b"Connections" {
                    saw_root = true;
                } else if element.name().as_ref() == b"Connection" {
                    stats.source_count += 1;
                    if stats.source_count > MAX_CONNECTIONS {
                        return Err(AppError::msg(format!(
                            "Navicat export contains more than {MAX_CONNECTIONS} connections"
                        )));
                    }
                    let attributes = read_attributes(&reader, &element)?;
                    if let Some(connection) =
                        connection_from_attributes(&attributes, stats.source_count, &mut stats)?
                    {
                        connections.push(connection);
                    }
                }
            }
            Ok(Event::DocType(_)) => {
                return Err(AppError::msg(
                    "Navicat export must not contain a document type declaration",
                ));
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(AppError::msg(format!(
                    "Invalid Navicat connection export: {error}"
                )));
            }
        }
        buffer.clear();
    }

    if !saw_root {
        return Err(AppError::msg(
            "Invalid Navicat connection export: missing Connections root",
        ));
    }

    Ok(NavicatImportPreview {
        connections,
        source_count: stats.source_count,
        unsupported_types: stats.unsupported_types.into_iter().collect(),
        password_count: stats.password_count,
        ssh_password_count: stats.ssh_password_count,
        http_tunnel_count: stats.http_tunnel_count,
        unsupported_ssl_count: stats.unsupported_ssl_count,
    })
}

fn read_attributes(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
) -> AppResult<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    for attribute in element.attributes() {
        let attribute = attribute
            .map_err(|error| AppError::msg(format!("Invalid Navicat attribute: {error}")))?;
        let key = String::from_utf8_lossy(attribute.key.as_ref()).to_ascii_lowercase();
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(|error| AppError::msg(format!("Invalid Navicat attribute value: {error}")))?
            .into_owned();
        if value.len() > MAX_ATTRIBUTE_BYTES {
            return Err(AppError::msg(format!(
                "Navicat attribute {key} exceeds the supported size"
            )));
        }
        values.insert(key, value);
    }
    Ok(values)
}

fn connection_from_attributes(
    attributes: &BTreeMap<String, String>,
    index: usize,
    stats: &mut PreviewStats,
) -> AppResult<Option<ConnectionConfig>> {
    let source_type = value(attributes, &["conntype"])
        .unwrap_or("UNKNOWN")
        .trim()
        .to_ascii_uppercase();
    let driver = match source_type.as_str() {
        "MYSQL" | "MARIADB" => DriverKind::Mysql,
        "POSTGRESQL" | "POSTGRES" | "PGSQL" => DriverKind::Postgres,
        "SQLITE" | "SQLITE3" => DriverKind::Sqlite,
        "REDIS" => DriverKind::Redis,
        _ => {
            stats.unsupported_types.insert(source_type);
            return Ok(None);
        }
    };

    if nonempty(attributes, &["password"]).is_some() {
        stats.password_count += 1;
    }
    if nonempty(attributes, &["ssh_password", "sshpassword"]).is_some() {
        stats.ssh_password_count += 1;
    }
    if flag(attributes, &["http"]) {
        stats.http_tunnel_count += 1;
    }

    let name = nonempty(attributes, &["connectionname", "name"])
        .map(str::to_string)
        .unwrap_or_else(|| format!("Imported connection {index}"));
    let port = nonempty(attributes, &["port"])
        .map(|port| {
            port.parse::<u16>()
                .map_err(|_| AppError::msg(format!("Invalid port in Navicat connection {index}")))
        })
        .transpose()?
        .or_else(|| driver.default_port());

    let ssl_mode = if driver == DriverKind::Sqlite {
        None
    } else if flag(attributes, &["ssl"]) {
        if has_nonempty_prefix(attributes, "ssl_client")
            || has_nonempty_prefix(attributes, "ssl_cacert")
            || nonempty(
                attributes,
                &["ssl_clientkey", "ssl_clientcert", "ssl_cacert"],
            )
            .is_some()
        {
            stats.unsupported_ssl_count += 1;
        }
        let navicat_mode = value(
            attributes,
            &["ssl_pgsslmode", "sslmode", "ssl_mode", "sslmysqlmode"],
        )
        .unwrap_or("REQUIRE")
        .to_ascii_uppercase();
        Some(
            if navicat_mode.contains("VERIFY_FULL")
                || navicat_mode.contains("VERIFY-FULL")
                || navicat_mode.contains("VERIFY_IDENTITY")
            {
                "verify-full"
            } else if navicat_mode.contains("VERIFY_CA") || navicat_mode.contains("VERIFY-CA") {
                "verify-ca"
            } else {
                "require"
            }
            .to_string(),
        )
    } else {
        Some("disable".to_string())
    };

    let ssh = if flag(attributes, &["ssh"]) {
        let host = nonempty(attributes, &["ssh_host", "sshhost"]);
        let username = nonempty(attributes, &["ssh_username", "sshusername"]);
        match (host, username) {
            (Some(host), Some(username)) => {
                let method = value(
                    attributes,
                    &["ssh_authenmethod", "ssh_authmethod", "sshauthenmethod"],
                )
                .unwrap_or("PASSWORD")
                .to_ascii_uppercase();
                let uses_key = method.contains("KEY") || method.contains("PUBLIC");
                Some(SshConfig {
                    host: host.to_string(),
                    port: nonempty(attributes, &["ssh_port", "sshport"])
                        .and_then(|port| port.parse::<u16>().ok())
                        .unwrap_or(22),
                    username: username.to_string(),
                    auth: Some(if uses_key { "key" } else { "password" }.to_string()),
                    key_path: if uses_key {
                        nonempty(attributes, &["ssh_privatekey", "ssh_keypath"]).map(str::to_string)
                    } else {
                        None
                    },
                    password: None,
                })
            }
            _ => None,
        }
    } else {
        None
    };

    let file_path = if driver == DriverKind::Sqlite {
        nonempty(
            attributes,
            &["databasefilename", "databasefile", "filepath", "file"],
        )
        .map(str::to_string)
    } else {
        None
    };

    Ok(Some(ConnectionConfig {
        id: String::new(),
        name,
        driver,
        host: if driver == DriverKind::Sqlite {
            None
        } else {
            nonempty(attributes, &["host"]).map(str::to_string)
        },
        port,
        database: if driver == DriverKind::Sqlite {
            None
        } else {
            nonempty(attributes, &["database", "initialdatabase"]).map(str::to_string)
        },
        username: if driver == DriverKind::Sqlite {
            None
        } else {
            nonempty(attributes, &["username", "user"]).map(str::to_string)
        },
        file_path,
        color: None,
        pinned: false,
        group: nonempty(
            attributes,
            &["group", "groupname", "virtualgroupname", "category"],
        )
        .map(str::to_string),
        ssl_mode,
        read_only: false,
        ssh,
        password: None,
    }))
}

fn value<'a>(attributes: &'a BTreeMap<String, String>, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| attributes.get(*name).map(String::as_str))
}

fn nonempty<'a>(attributes: &'a BTreeMap<String, String>, names: &[&str]) -> Option<&'a str> {
    value(attributes, names)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn flag(attributes: &BTreeMap<String, String>, names: &[&str]) -> bool {
    value(attributes, names)
        .map(str::trim)
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
        .unwrap_or(false)
}

fn has_nonempty_prefix(attributes: &BTreeMap<String, String>, prefix: &str) -> bool {
    attributes
        .iter()
        .any(|(key, value)| key.starts_with(prefix) && !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_connections_without_importing_passwords() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="MySQL local" ConnType="MYSQL" Host="127.0.0.1" Port="3306" UserName="root" Password="encrypted" SSL="false" SSH="true" SSH_Host="bastion" SSH_Port="2222" SSH_UserName="ops" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="/tmp/test-key" SSH_Password="encrypted-ssh"/>
  <Connection ConnectionName="PG" ConnType="POSTGRESQL" Host="db.local" Port="5432" Database="app" UserName="postgres" SSL="true" SSL_PGSSLMode="VERIFY_FULL"/>
  <Connection ConnectionName="SQLite" ConnType="SQLITE" DatabaseFileName="/tmp/app.db"/>
  <Connection ConnectionName="Cache" ConnType="REDIS" Host="cache.local" Port="6379" Database="3"/>
</Connections>"#;

        let preview = parse_navicat_xml(xml).unwrap();
        assert_eq!(preview.source_count, 4);
        assert_eq!(preview.connections.len(), 4);
        assert_eq!(preview.password_count, 1);
        assert_eq!(preview.ssh_password_count, 1);
        assert!(preview
            .connections
            .iter()
            .all(|connection| connection.password.is_none()));

        let mysql = &preview.connections[0];
        assert_eq!(mysql.driver, DriverKind::Mysql);
        assert_eq!(mysql.ssl_mode.as_deref(), Some("disable"));
        assert_eq!(mysql.ssh.as_ref().unwrap().auth.as_deref(), Some("key"));
        assert_eq!(mysql.ssh.as_ref().unwrap().port, 2222);

        let postgres = &preview.connections[1];
        assert_eq!(postgres.ssl_mode.as_deref(), Some("verify-full"));
        assert_eq!(postgres.database.as_deref(), Some("app"));

        let sqlite = &preview.connections[2];
        assert_eq!(sqlite.file_path.as_deref(), Some("/tmp/app.db"));
        assert!(sqlite.ssl_mode.is_none());

        let redis = &preview.connections[3];
        assert_eq!(redis.database.as_deref(), Some("3"));
    }

    #[test]
    fn reports_unsupported_types_without_exposing_connection_values() {
        let xml = br#"<Connections Ver="1.5"><Connection ConnectionName="secret-name" ConnType="ORACLE" Host="secret-host"/></Connections>"#;
        let preview = parse_navicat_xml(xml).unwrap();
        assert_eq!(preview.source_count, 1);
        assert!(preview.connections.is_empty());
        assert_eq!(preview.unsupported_types, vec!["ORACLE"]);
    }

    #[test]
    fn rejects_document_type_declarations() {
        let xml =
            br#"<!DOCTYPE Connections [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Connections/>"#;
        assert!(parse_navicat_xml(xml).is_err());
    }

    #[test]
    fn preserves_verify_ca_without_upgrading_to_hostname_verification() {
        let xml = br#"<Connections><Connection ConnectionName="PG" ConnType="POSTGRESQL" Host="db.internal" UserName="postgres" SSL="true" SSL_PGSSLMode="VERIFY_CA"/></Connections>"#;
        let preview = parse_navicat_xml(xml).unwrap();
        assert_eq!(
            preview.connections[0].ssl_mode.as_deref(),
            Some("verify-ca")
        );
    }

    #[test]
    fn rejects_files_larger_than_the_import_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.ncx");
        std::fs::write(&path, vec![b'x'; MAX_NCX_BYTES as usize + 1]).unwrap();

        let error = preview_navicat_connections(path.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.to_string().contains("too large"));
    }
}
