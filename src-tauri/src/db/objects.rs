//! Schema-object inspection and editing for the dedicated object manager.
use crate::db::data::quote_ident;
use crate::db::design::{self, ForeignKey, IndexInfo};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "operation")]
pub enum IndexChange {
    Create {
        name: String,
        columns: Vec<String>,
        unique: bool,
        method: Option<String>,
        #[serde(default)]
        prefix_lengths: Vec<Option<u16>>,
    },
    Drop {
        name: String,
    },
    Replace {
        old_name: String,
        name: String,
        columns: Vec<String>,
        unique: bool,
        method: Option<String>,
        #[serde(default)]
        prefix_lengths: Vec<Option<u16>>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ForeignKeyDefinition {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: Option<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

impl From<&ForeignKey> for ForeignKeyDefinition {
    fn from(value: &ForeignKey) -> Self {
        Self {
            name: value.name.clone(),
            columns: value.columns.clone(),
            referenced_schema: value.referenced_schema.clone(),
            referenced_table: value.referenced_table.clone(),
            referenced_columns: value.referenced_columns.clone(),
            on_update: value.on_update.clone(),
            on_delete: value.on_delete.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedObject {
    pub kind: String,
    pub schema: Option<String>,
    pub name: String,
    pub table: Option<String>,
    pub definition: Option<String>,
    pub drop_sql: Option<String>,
    pub identity: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedUser {
    pub name: String,
    pub host: Option<String>,
    pub grants: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObjectCatalog {
    pub objects: Vec<ManagedObject>,
    pub users: Vec<ManagedUser>,
    pub supported: Vec<String>,
}

fn clean_ident(value: &str, what: &str) -> AppResult<()> {
    if value.trim().is_empty() {
        return Err(AppError::msg(format!("{what} cannot be empty")));
    }
    Ok(())
}

fn mysql_grantee_part(text: &str) -> Option<(String, &str)> {
    let text = text.strip_prefix('\'')?;
    let mut result = String::new();
    let mut chars = text.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if ch == '\'' {
            if chars.peek().is_some_and(|(_, next)| *next == '\'') {
                chars.next();
                result.push('\'');
            } else {
                return Some((result, &text[index + 1..]));
            }
        } else {
            result.push(ch);
        }
    }
    None
}

fn split_mysql_grantee(value: &str) -> (String, String) {
    if let Some((user, rest)) = mysql_grantee_part(value) {
        if let Some((host, _)) = mysql_grantee_part(rest.strip_prefix('@').unwrap_or("")) {
            return (user, host);
        }
    }
    (value.to_string(), "%".into())
}

fn qualified(driver: DriverKind, schema: Option<&str>, name: &str) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(schema) => format!(
            "{}.{}",
            quote_ident(driver, schema),
            quote_ident(driver, name)
        ),
        None => quote_ident(driver, name),
    }
}

// Mirrors the structured index request, including per-column prefix lengths.
#[allow(clippy::too_many_arguments)]
fn index_sql(
    driver: DriverKind,
    schema: Option<&str>,
    table: &str,
    name: &str,
    columns: &[String],
    unique: bool,
    method: Option<&str>,
    prefix_lengths: &[Option<u16>],
) -> AppResult<String> {
    clean_ident(name, "index name")?;
    if columns.is_empty() {
        return Err(AppError::msg("an index must contain at least one column"));
    }
    for column in columns {
        clean_ident(column, "index column")?;
    }
    if !prefix_lengths.is_empty() && prefix_lengths.len() != columns.len() {
        return Err(AppError::msg(
            "provide one MySQL prefix length per indexed column (leave unused lengths blank)",
        ));
    }
    let cols = columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let ident = quote_ident(driver, c);
            match (driver, prefix_lengths.get(i).copied().flatten()) {
                (DriverKind::Mysql, Some(length)) if length > 0 => format!("{ident}({length})"),
                (DriverKind::Mysql, Some(_)) => String::new(),
                (_, Some(_)) => String::new(),
                _ => ident,
            }
        })
        .collect::<Vec<_>>();
    if cols.iter().any(String::is_empty) {
        return Err(AppError::msg(
            "index prefix lengths must be positive and are supported only by MySQL",
        ));
    }
    let cols = cols.join(", ");
    let unique = if unique { "UNIQUE " } else { "" };
    let sql = match driver {
        DriverKind::Sqlite => {
            if method.is_some() {
                return Err(AppError::msg("SQLite does not support index methods"));
            }
            format!(
                "CREATE {unique}INDEX {} ON {} ({cols})",
                quote_ident(driver, name),
                qualified(driver, None, table)
            )
        }
        DriverKind::Postgres => {
            let method = method.unwrap_or("btree").to_ascii_lowercase();
            if !["btree", "hash", "gist", "gin", "brin", "spgist"].contains(&method.as_str()) {
                return Err(AppError::msg("unsupported PostgreSQL index method"));
            }
            format!(
                "CREATE {unique}INDEX {} ON {} USING {} ({cols})",
                quote_ident(driver, name),
                qualified(driver, schema, table),
                method
            )
        }
        DriverKind::Mysql => {
            let method = method.unwrap_or("BTREE").to_ascii_uppercase();
            if !["BTREE", "HASH"].contains(&method.as_str()) {
                return Err(AppError::msg("unsupported MySQL index method"));
            }
            format!(
                "CREATE {unique}INDEX {} USING {method} ON {} ({cols})",
                quote_ident(driver, name),
                qualified(driver, schema, table)
            )
        }
        DriverKind::Redis => return crate::db::redis_ops::unsupported("Index editing"),
    };
    Ok(sql)
}

pub async fn apply_index_change(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
    change: &IndexChange,
) -> AppResult<()> {
    let driver = pool.driver();
    match change {
        IndexChange::Create {
            name,
            columns,
            unique,
            method,
            prefix_lengths,
        } => {
            let sql = index_sql(
                driver,
                schema,
                table,
                name,
                columns,
                *unique,
                method.as_deref(),
                prefix_lengths,
            )?;
            execute_ddl(pool, &sql).await
        }
        IndexChange::Drop { name } => {
            clean_ident(name, "index name")?;
            let sql = drop_index_sql(driver, schema, table, name);
            execute_ddl(pool, &sql).await
        }
        IndexChange::Replace {
            old_name,
            name,
            columns,
            unique,
            method,
            prefix_lengths,
        } => {
            clean_ident(old_name, "old index name")?;
            let create = index_sql(
                driver,
                schema,
                table,
                name,
                columns,
                *unique,
                method.as_deref(),
                prefix_lengths,
            )?;
            ensure_index_replace_is_lossless(pool, schema, table, old_name).await?;
            match pool {
                DbPool::Sqlite(p) => {
                    let mut tx = p.begin().await?;
                    sqlx::query(&drop_index_sql(driver, schema, table, old_name))
                        .execute(&mut *tx)
                        .await?;
                    sqlx::query(&create).execute(&mut *tx).await?;
                    tx.commit().await?;
                    Ok(())
                }
                DbPool::Postgres(p) => {
                    let mut tx = p.begin().await?;
                    sqlx::query(&drop_index_sql(driver, schema, table, old_name))
                        .execute(&mut *tx)
                        .await?;
                    sqlx::query(&create).execute(&mut *tx).await?;
                    tx.commit().await?;
                    Ok(())
                }
                DbPool::Mysql(_) => {
                    // Construct ALTER directly; stripping CREATE's ON clause
                    // would also lose its complete indexed-column list.
                    let columns_sql = columns
                        .iter()
                        .enumerate()
                        .map(|(index, column)| {
                            let quoted = quote_ident(driver, column);
                            prefix_lengths
                                .get(index)
                                .copied()
                                .flatten()
                                .map(|length| format!("{quoted}({length})"))
                                .unwrap_or(quoted)
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    let unique_clause = if *unique { "UNIQUE " } else { "" };
                    let method = method.as_deref().unwrap_or("BTREE").to_ascii_uppercase();
                    let sql = format!("ALTER TABLE {} DROP INDEX {}, ADD {unique_clause}INDEX {} USING {method} ({columns_sql})", qualified(driver, schema, table), quote_ident(driver, old_name), quote_ident(driver, name));
                    execute_ddl(pool, &sql).await
                }
                DbPool::Redis(_) => crate::db::redis_ops::unsupported("Index editing"),
            }
        }
    }
}

async fn ensure_index_replace_is_lossless(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
    name: &str,
) -> AppResult<()> {
    let unsupported = match pool {
        DbPool::Sqlite(p) => {
            let rows = sqlx::query(&format!(
                "PRAGMA index_info({})",
                quote_ident(DriverKind::Sqlite, name)
            ))
            .fetch_all(p)
            .await?;
            let expression = rows.iter().any(|r| {
                r.try_get::<Option<String>, _>("name")
                    .ok()
                    .flatten()
                    .is_none()
            });
            let ddl: Option<String> =
                sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
                    .bind(name)
                    .fetch_optional(p)
                    .await?;
            expression || ddl.is_some_and(|sql| contains_bare_word(&sql, "WHERE"))
        }
        DbPool::Postgres(p) => {
            let rows = sqlx::query("SELECT ix.indexprs IS NOT NULL AS expression, ix.indpred IS NOT NULL AS partial FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_namespace n ON n.oid=i.relnamespace WHERE i.relname=$1 AND n.nspname=COALESCE($2,current_schema())")
                .bind(name).bind(schema.filter(|s| !s.is_empty())).fetch_all(p).await?;
            rows.iter().any(|r| {
                r.try_get::<bool, _>("expression").unwrap_or(true)
                    || r.try_get::<bool, _>("partial").unwrap_or(true)
            })
        }
        DbPool::Mysql(p) => {
            let sql = match schema {
                Some(s) => format!(
                    "SHOW INDEX FROM {} FROM {}",
                    quote_ident(DriverKind::Mysql, table),
                    quote_ident(DriverKind::Mysql, s)
                ),
                None => format!("SHOW INDEX FROM {}", quote_ident(DriverKind::Mysql, table)),
            };
            let rows = sqlx::raw_sql(&sql).fetch_all(p).await?;
            rows.iter()
                .filter(|r| r.try_get::<String, _>("Key_name").ok().as_deref() == Some(name))
                .any(|r| {
                    r.try_get::<Option<i64>, _>("Sub_part")
                        .ok()
                        .flatten()
                        .is_some()
                        || r.try_get::<Option<String>, _>("Column_name")
                            .ok()
                            .flatten()
                            .is_none()
                        || r.try_get::<Option<String>, _>("Expression")
                            .ok()
                            .flatten()
                            .is_some()
                })
        }
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Index editing"),
    };
    if unsupported {
        return Err(AppError::msg("this index uses an expression, prefix, or partial predicate that the editor cannot reproduce; refusing a lossy replacement"));
    }
    Ok(())
}

fn drop_index_sql(driver: DriverKind, schema: Option<&str>, table: &str, name: &str) -> String {
    match driver {
        DriverKind::Sqlite => format!("DROP INDEX {}", quote_ident(driver, name)),
        DriverKind::Postgres => format!("DROP INDEX {}", qualified(driver, schema, name)),
        DriverKind::Mysql => format!(
            "DROP INDEX {} ON {}",
            quote_ident(driver, name),
            qualified(driver, schema, table)
        ),
        DriverKind::Redis => String::new(),
    }
}

fn action(value: Option<&str>) -> AppResult<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_ascii_uppercase().replace('_', " ");
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if ![
        "NO ACTION",
        "RESTRICT",
        "SET NULL",
        "SET DEFAULT",
        "CASCADE",
    ]
    .contains(&normalized.as_str())
    {
        return Err(AppError::msg("unsupported foreign-key action"));
    }
    Ok(Some(normalized))
}

fn validate_foreign_keys(driver: DriverKind, keys: &[ForeignKeyDefinition]) -> AppResult<()> {
    let mut names = HashSet::new();
    for key in keys {
        clean_ident(&key.name, "foreign-key name")?;
        clean_ident(&key.referenced_table, "referenced table")?;
        if key.columns.is_empty() || key.columns.len() != key.referenced_columns.len() {
            return Err(AppError::msg(
                "foreign key must map the same number of local and referenced columns",
            ));
        }
        for name in key.columns.iter().chain(&key.referenced_columns) {
            clean_ident(name, "foreign-key column")?;
        }
        if !names.insert(key.name.to_ascii_lowercase()) {
            return Err(AppError::msg("foreign-key names must be unique"));
        }
        action(key.on_update.as_deref())?;
        action(key.on_delete.as_deref())?;
        if driver == DriverKind::Sqlite
            && key
                .referenced_schema
                .as_deref()
                .is_some_and(|s| !s.is_empty() && s != "main")
        {
            return Err(AppError::msg(
                "SQLite foreign keys can only reference the main database",
            ));
        }
    }
    Ok(())
}

fn fk_clause(driver: DriverKind, key: &ForeignKeyDefinition) -> String {
    let local = key
        .columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let remote = key
        .referenced_columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let mut clause = format!(
        "CONSTRAINT {} FOREIGN KEY ({local}) REFERENCES {} ({remote})",
        quote_ident(driver, &key.name),
        qualified(
            driver,
            key.referenced_schema.as_deref(),
            &key.referenced_table
        )
    );
    if let Ok(Some(a)) = action(key.on_update.as_deref()) {
        clause.push_str(&format!(" ON UPDATE {a}"));
    }
    if let Ok(Some(a)) = action(key.on_delete.as_deref()) {
        clause.push_str(&format!(" ON DELETE {a}"));
    }
    clause
}

pub async fn apply_foreign_key_changes(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
    keys: &[ForeignKeyDefinition],
) -> AppResult<()> {
    let driver = pool.driver();
    validate_foreign_keys(driver, keys)?;
    let current = design::describe(pool, schema, table).await?;
    match pool {
        DbPool::Sqlite(p) => {
            rebuild_sqlite_foreign_keys(p, table, &current.foreign_keys, keys).await
        }
        DbPool::Postgres(p) => {
            let constraints = sqlx::query(
                "SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='f' AND t.relname=$1 AND n.nspname=COALESCE($2,current_schema())",
            )
            .bind(table)
            .bind(schema.filter(|s| !s.is_empty()))
            .fetch_all(p)
            .await?;
            for row in constraints {
                let definition: String = row.try_get("definition")?;
                let upper = definition.to_ascii_uppercase();
                if upper.contains("DEFERRABLE")
                    || upper.contains("MATCH FULL")
                    || upper.contains("MATCH PARTIAL")
                    || upper.contains("SET NULL (")
                    || upper.contains("SET DEFAULT (")
                {
                    return Err(AppError::msg("an existing PostgreSQL foreign key uses options this editor cannot represent; refusing to discard them"));
                }
            }
            replace_named_foreign_keys(pool, driver, schema, table, &current.foreign_keys, keys)
                .await
        }
        DbPool::Mysql(_) => {
            replace_named_foreign_keys(pool, driver, schema, table, &current.foreign_keys, keys)
                .await
        }
        DbPool::Redis(_) => crate::db::redis_ops::unsupported("Foreign-key editing"),
    }
}

async fn replace_named_foreign_keys(
    pool: &DbPool,
    driver: DriverKind,
    schema: Option<&str>,
    table: &str,
    current: &[ForeignKey],
    desired: &[ForeignKeyDefinition],
) -> AppResult<()> {
    let mut clauses = Vec::new();
    for old in current {
        clean_ident(&old.name, "existing foreign-key name")?;
        clauses.push(match driver {
            DriverKind::Postgres => format!("DROP CONSTRAINT {}", quote_ident(driver, &old.name)),
            DriverKind::Mysql => format!("DROP FOREIGN KEY {}", quote_ident(driver, &old.name)),
            _ => unreachable!(),
        });
    }
    clauses.extend(
        desired
            .iter()
            .map(|key| format!("ADD {}", fk_clause(driver, key))),
    );
    if clauses.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "ALTER TABLE {} {}",
        qualified(driver, schema, table),
        clauses.join(", ")
    );
    execute_ddl(pool, &sql).await
}

async fn execute_ddl(pool: &DbPool, sql: &str) -> AppResult<()> {
    match pool {
        DbPool::Sqlite(p) => {
            sqlx::query(sql).execute(p).await?;
        }
        DbPool::Postgres(p) => {
            sqlx::query(sql).execute(p).await?;
        }
        // MySQL rejects several DDL statements in the prepared protocol.
        DbPool::Mysql(p) => {
            sqlx::raw_sql(sql).execute(p).await?;
        }
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Schema-object editing"),
    }
    Ok(())
}

struct SqliteGuardedConnection {
    connection: sqlx::pool::PoolConnection<sqlx::Sqlite>,
    reusable: bool,
}

impl Drop for SqliteGuardedConnection {
    fn drop(&mut self) {
        if !self.reusable {
            self.connection.close_on_drop();
        }
    }
}

async fn rebuild_sqlite_foreign_keys(
    pool: &sqlx::SqlitePool,
    table: &str,
    existing: &[ForeignKey],
    desired: &[ForeignKeyDefinition],
) -> AppResult<()> {
    let options = pool.connect_options();
    let filename = options.get_filename();
    if filename.as_os_str().is_empty() || filename == std::path::Path::new(":memory:") {
        return Err(AppError::msg("SQLite foreign-key changes require a file-backed database so the guarded rebuild can safely close its connection"));
    }
    let mut connection = SqliteGuardedConnection {
        connection: pool.acquire().await?,
        reusable: false,
    };
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection.connection)
        .await?;
    let result =
        rebuild_sqlite_transaction(&mut connection.connection, table, existing, desired).await;
    let restore_fk = sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection.connection)
        .await;
    match (result, restore_fk) {
        (Ok(()), Ok(_)) => {
            connection.reusable = true;
            Ok(())
        }
        (Err(error), Ok(_)) => Err(error),
        (Ok(()), Err(error)) => Err(AppError::msg(format!(
            "foreign keys were changed but SQLite enforcement could not be re-enabled: {error}"
        ))),
        (Err(error), Err(cleanup)) => Err(AppError::msg(format!(
            "{error}; additionally failed to restore SQLite foreign-key enforcement: {cleanup}"
        ))),
    }
}

async fn rebuild_sqlite_transaction(
    connection: &mut sqlx::pool::PoolConnection<sqlx::Sqlite>,
    table: &str,
    existing: &[ForeignKey],
    desired: &[ForeignKeyDefinition],
) -> AppResult<()> {
    let old_ddl: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
            .bind(table)
            .fetch_optional(&mut **connection)
            .await?
            .ok_or_else(|| AppError::msg("SQLite table definition is unavailable"))?;
    let (body_start, body_end) = create_table_body(&old_ddl)?;
    let body = &old_ddl[body_start..body_end];
    let clauses = split_table_clauses(body)?;
    let mut preserved = Vec::new();
    let mut fk_count = 0usize;
    for clause in clauses {
        let part = clause.trim();
        if is_table_foreign_key(part) {
            let upper = part.to_ascii_uppercase();
            if upper.contains("DEFERRABLE")
                || upper.contains("INITIALLY")
                || upper.contains("MATCH ")
            {
                return Err(AppError::msg("SQLite foreign key uses a deferrability or MATCH option this editor cannot represent; refusing to discard it"));
            }
            fk_count += 1;
        } else {
            if contains_bare_word(part, "REFERENCES") {
                return Err(AppError::msg("SQLite table uses an inline column REFERENCES clause; refusing an incomplete foreign-key rebuild"));
            }
            preserved.push(part.to_string());
        }
    }
    if fk_count != existing.len() {
        return Err(AppError::msg("SQLite foreign-key definitions do not match the CREATE TABLE text; refusing to risk losing a constraint"));
    }
    preserved.extend(desired.iter().map(|key| fk_clause(DriverKind::Sqlite, key)));
    let new_body = preserved.join(", ");
    let new_ddl = format!(
        "{}{}{}{}",
        &old_ddl[..body_start],
        new_body,
        &old_ddl[body_end..],
        ""
    );
    let temporary = format!("__rdbstudio_restore_{}", uuid::Uuid::new_v4().simple());
    let temp_ddl = replace_create_table_name(&new_ddl, &temporary)?;

    let saved_objects: Vec<(String, String)> = sqlx::query_as(
        "SELECT type, sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name",
    ).bind(table).fetch_all(&mut **connection).await?;
    let columns: Vec<(String, i64)> =
        sqlx::query("SELECT name, hidden FROM pragma_table_xinfo(?) ORDER BY cid")
            .bind(table)
            .fetch_all(&mut **connection)
            .await?
            .into_iter()
            .map(|r| Ok((r.try_get("name")?, r.try_get("hidden")?)))
            .collect::<Result<_, sqlx::Error>>()?;
    let copy_columns: Vec<String> = columns
        .iter()
        .filter(|(_, hidden)| *hidden == 0)
        .map(|(n, _)| quote_ident(DriverKind::Sqlite, n))
        .collect();
    if copy_columns.is_empty() {
        return Err(AppError::msg(
            "SQLite table has no copyable columns; refusing a data-losing rebuild",
        ));
    }
    let sequence: Option<i64> = if sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'",
    )
    .fetch_one(&mut **connection)
    .await?
        > 0
    {
        sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name=?")
            .bind(table)
            .fetch_optional(&mut **connection)
            .await?
    } else {
        None
    };

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut **connection)
        .await?;
    let operation = async {
        sqlx::query(&temp_ddl).execute(&mut **connection).await?;
        let cols = copy_columns.join(", ");
        let old = quote_ident(DriverKind::Sqlite, table);
        let temp = quote_ident(DriverKind::Sqlite, &temporary);
        sqlx::query(&format!(
            "INSERT INTO {temp} ({cols}) SELECT {cols} FROM {old}"
        ))
        .execute(&mut **connection)
        .await?;
        sqlx::query(&format!("DROP TABLE {old}"))
            .execute(&mut **connection)
            .await?;
        sqlx::query(&format!("ALTER TABLE {temp} RENAME TO {old}"))
            .execute(&mut **connection)
            .await?;
        for (_, ddl) in &saved_objects {
            sqlx::query(ddl).execute(&mut **connection).await?;
        }
        if let Some(sequence) = sequence {
            sqlx::query("UPDATE sqlite_sequence SET seq=max(seq, ?) WHERE name=?")
                .bind(sequence)
                .bind(table)
                .execute(&mut **connection)
                .await?;
        }
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut **connection)
            .await?;
        if !violations.is_empty() {
            return Err(sqlx::Error::Protocol(format!(
                "foreign_key_check found {} violation(s)",
                violations.len()
            )));
        }
        Ok::<(), sqlx::Error>(())
    }
    .await;
    match operation {
        Ok(()) => {
            sqlx::query("COMMIT").execute(&mut **connection).await?;
            Ok(())
        }
        Err(error) => {
            let rollback = sqlx::query("ROLLBACK").execute(&mut **connection).await;
            if let Err(rollback) = rollback {
                return Err(AppError::msg(format!(
                    "SQLite foreign-key rebuild failed: {error}; rollback failed: {rollback}"
                )));
            }
            Err(AppError::msg(format!(
                "SQLite foreign-key rebuild failed: {error}"
            )))
        }
    }
}

fn create_table_body(sql: &str) -> AppResult<(usize, usize)> {
    let bytes = sql.as_bytes();
    let mut quote = None;
    let mut opening = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if let Some(q) = quote {
            if c == q {
                if bytes.get(i + 1).copied() == Some(q as u8) {
                    i += 2;
                    continue;
                }
                quote = None;
            }
        } else if matches!(c, '\'' | '"' | '`') {
            quote = Some(c);
        } else if c == '[' {
            quote = Some(']');
        } else if c == '(' {
            opening = Some(i);
            break;
        }
        i += 1;
    }
    let start = opening.ok_or_else(|| AppError::msg("cannot parse SQLite CREATE TABLE body"))?;
    let mut depth = 0i32;
    quote = None;
    i = start;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if let Some(q) = quote {
            if c == q {
                if bytes.get(i + 1).copied() == Some(q as u8) {
                    i += 2;
                    continue;
                }
                quote = None;
            }
        } else if matches!(c, '\'' | '"' | '`') {
            quote = Some(c);
        } else if c == '[' {
            quote = Some(']');
        } else if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
            if depth == 0 {
                return Ok((start + 1, i));
            }
        }
        i += 1;
    }
    Err(AppError::msg("unclosed SQLite CREATE TABLE body"))
}

fn split_table_clauses(body: &str) -> AppResult<Vec<&str>> {
    let bytes = body.as_bytes();
    let mut result = Vec::new();
    let mut start = 0usize;
    let mut depth = 0i32;
    let mut quote = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if let Some(q) = quote {
            if c == q {
                if bytes.get(i + 1).copied() == Some(q as u8) {
                    i += 2;
                    continue;
                }
                quote = None;
            }
        } else if matches!(c, '\'' | '"' | '`') {
            quote = Some(c);
        } else if c == '[' {
            quote = Some(']');
        } else if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
            if depth < 0 {
                return Err(AppError::msg("malformed SQLite CREATE TABLE clauses"));
            }
        } else if c == ',' && depth == 0 {
            result.push(&body[start..i]);
            start = i + 1;
        }
        i += 1;
    }
    if depth != 0 || quote.is_some() {
        return Err(AppError::msg("malformed SQLite CREATE TABLE clauses"));
    }
    result.push(&body[start..]);
    Ok(result)
}

fn is_table_foreign_key(clause: &str) -> bool {
    let upper = clause.trim_start().to_ascii_uppercase();
    if upper.starts_with("FOREIGN KEY") {
        return true;
    }
    if let Some(rest) = upper.strip_prefix("CONSTRAINT ") {
        let rest = rest.trim_start();
        // Skip a quoted or unquoted constraint name.
        let rest = if let Some(q) = rest.chars().next().filter(|c| matches!(c, '"' | '`' | '[')) {
            let end = if q == '[' { ']' } else { q };
            rest[1..].find(end).map(|i| &rest[i + 2..]).unwrap_or("")
        } else {
            rest.split_once(char::is_whitespace)
                .map(|(_, r)| r)
                .unwrap_or("")
        };
        return rest.trim_start().starts_with("FOREIGN KEY");
    }
    false
}

fn contains_bare_word(sql: &str, needle: &str) -> bool {
    sql.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|word| word.eq_ignore_ascii_case(needle))
}

fn replace_create_table_name(sql: &str, name: &str) -> AppResult<String> {
    let upper = sql.to_ascii_uppercase();
    let table = upper
        .find("TABLE")
        .ok_or_else(|| AppError::msg("invalid SQLite CREATE TABLE statement"))?
        + 5;
    let open = create_table_body(sql)?.0 - 1;
    let prefix = &sql[table..open];
    let start = prefix
        .find(|c: char| !c.is_whitespace())
        .ok_or_else(|| AppError::msg("missing SQLite table name"))?
        + table;
    let mut name_start = start;
    if sql[name_start..]
        .to_ascii_uppercase()
        .starts_with("IF NOT EXISTS")
    {
        name_start += "IF NOT EXISTS".len();
        while sql
            .as_bytes()
            .get(name_start)
            .is_some_and(u8::is_ascii_whitespace)
        {
            name_start += 1;
        }
    }
    let end = scan_sqlite_identifier(sql, name_start)?;
    Ok(format!(
        "{}{}{}",
        &sql[..name_start],
        quote_ident(DriverKind::Sqlite, name),
        &sql[end..]
    ))
}

fn scan_sqlite_identifier(sql: &str, start: usize) -> AppResult<usize> {
    let bytes = sql.as_bytes();
    let mut i = start;
    let mut quote = match bytes.get(i).copied() {
        Some(b'"') => Some(b'"'),
        Some(b'`') => Some(b'`'),
        Some(b'[') => Some(b']'),
        _ => None,
    };
    if let Some(end_quote) = quote {
        i += 1;
        while i < bytes.len() {
            if bytes[i] == end_quote {
                if bytes.get(i + 1) == Some(&end_quote) {
                    i += 2;
                    continue;
                }
                i += 1;
                break;
            }
            i += 1;
        }
        quote = None;
    } else {
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'(' {
            i += 1;
        }
    }
    let _ = quote;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if matches!(bytes.get(i), Some(b'"' | b'`' | b'[')) {
            let end_quote = if bytes[i] == b'[' { b']' } else { bytes[i] };
            i += 1;
            while i < bytes.len() && bytes[i] != end_quote {
                i += 1;
            }
            i += usize::from(i < bytes.len());
        } else {
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'(' {
                i += 1;
            }
        }
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
    }
    if i == start {
        return Err(AppError::msg("cannot parse SQLite table identifier"));
    }
    Ok(i)
}

pub async fn list_managed_objects(pool: &DbPool, schema: Option<&str>) -> AppResult<ObjectCatalog> {
    list_managed_objects_scoped(pool, schema, None).await
}

/// List schema objects, or only triggers attached to one exact table when `table` is set.
pub async fn list_managed_objects_scoped(
    pool: &DbPool,
    schema: Option<&str>,
    table: Option<&str>,
) -> AppResult<ObjectCatalog> {
    let mut catalog = ObjectCatalog {
        objects: Vec::new(),
        users: Vec::new(),
        supported: Vec::new(),
    };
    match pool {
        DbPool::Sqlite(p) => {
            let rows = if let Some(table) = table {
                sqlx::query("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name")
                    .bind(table).fetch_all(p).await?
            } else {
                sqlx::query("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
                    .fetch_all(p).await?
            };
            catalog.objects = rows
                .iter()
                .map(|r| {
                    let name: String = r.try_get("name").unwrap_or_default();
                    ManagedObject {
                        kind: "trigger".into(),
                        identity: None,
                        schema: None,
                        name: name.clone(),
                        table: r.try_get("tbl_name").ok(),
                        definition: r.try_get("sql").ok(),
                        drop_sql: Some(format!(
                            "DROP TRIGGER {}",
                            quote_ident(DriverKind::Sqlite, &name)
                        )),
                    }
                })
                .collect();
            catalog.supported = if table.is_some() {
                vec!["trigger".into()]
            } else {
                vec!["trigger".into(), "index".into(), "foreign_key".into()]
            };
        }
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or("public");
            if table.is_none() {
                let rows = sqlx::query("SELECT n.nspname, p.proname, p.prokind::text AS prokind, pg_get_functiondef(p.oid) AS definition, pg_get_function_identity_arguments(p.oid) AS identity_args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind IN ('f','p') ORDER BY p.proname")
                .bind(schema).fetch_all(p).await?;
                for r in rows {
                    let kind: String = r.try_get("prokind")?;
                    let schema: String = r.try_get("nspname")?;
                    let name: String = r.try_get("proname")?;
                    let identity: String = r.try_get("identity_args")?;
                    let kind_name = if kind == "p" { "procedure" } else { "function" };
                    let verb = if kind == "p" { "PROCEDURE" } else { "FUNCTION" };
                    catalog.objects.push(ManagedObject {
                        kind: kind_name.into(),
                        identity: Some(identity.clone()),
                        schema: Some(schema.clone()),
                        name: name.clone(),
                        table: None,
                        definition: r.try_get("definition").ok(),
                        drop_sql: Some(format!(
                            "DROP {verb} {}({identity})",
                            qualified(DriverKind::Postgres, Some(&schema), &name)
                        )),
                    });
                }
            }
            let triggers = if let Some(table) = table {
                sqlx::query("SELECT n.nspname, c.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid, true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname=$1 AND c.relname=$2 ORDER BY c.relname,t.tgname")
                    .bind(schema).bind(table).fetch_all(p).await?
            } else {
                sqlx::query("SELECT n.nspname, c.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid, true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname=$1 ORDER BY c.relname,t.tgname")
                    .bind(schema).fetch_all(p).await?
            };
            for r in triggers {
                let schema: String = r.try_get("nspname")?;
                let table: String = r.try_get("table_name")?;
                let name: String = r.try_get("tgname")?;
                catalog.objects.push(ManagedObject {
                    kind: "trigger".into(),
                    identity: None,
                    schema: Some(schema.clone()),
                    name: name.clone(),
                    table: Some(table.clone()),
                    definition: r.try_get("definition").ok(),
                    drop_sql: Some(format!(
                        "DROP TRIGGER {} ON {}",
                        quote_ident(DriverKind::Postgres, &name),
                        qualified(DriverKind::Postgres, Some(&schema), &table)
                    )),
                });
            }
            if table.is_none() {
                let grant_rows = sqlx::query("SELECT grantee, table_schema || '.' || table_name || ': ' || privilege_type AS privilege FROM information_schema.role_table_grants ORDER BY grantee, table_schema, table_name, privilege_type")
                .fetch_all(p).await?;
                let mut grant_map: HashMap<String, Vec<String>> = HashMap::new();
                for r in grant_rows {
                    grant_map
                        .entry(r.try_get("grantee")?)
                        .or_default()
                        .push(r.try_get("privilege")?);
                }
                let users =
                    sqlx::query("SELECT rolname FROM pg_roles WHERE rolcanlogin ORDER BY rolname")
                        .fetch_all(p)
                        .await?;
                for r in users {
                    let name: String = r.try_get("rolname")?;
                    catalog.users.push(ManagedUser {
                        grants: grant_map.remove(&name).unwrap_or_default(),
                        name,
                        host: None,
                    });
                }
            }
            catalog.supported = if table.is_some() {
                vec!["trigger".into()]
            } else {
                vec![
                    "function".into(),
                    "procedure".into(),
                    "trigger".into(),
                    "user".into(),
                    "permission".into(),
                    "index".into(),
                    "foreign_key".into(),
                ]
            };
        }
        DbPool::Mysql(p) => {
            let schema = schema.unwrap_or("");
            if table.is_none() {
                let routines = sqlx::query("SELECT CAST(ROUTINE_SCHEMA AS CHAR) AS ROUTINE_SCHEMA, CAST(ROUTINE_NAME AS CHAR) AS ROUTINE_NAME, CAST(ROUTINE_TYPE AS CHAR) AS ROUTINE_TYPE, CAST(ROUTINE_DEFINITION AS CHAR) AS ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=COALESCE(NULLIF(?,''),DATABASE()) ORDER BY ROUTINE_NAME")
                .bind(schema).fetch_all(p).await?;
                for r in routines {
                    let kind: String = r.try_get("ROUTINE_TYPE")?;
                    let schema: String = r.try_get("ROUTINE_SCHEMA")?;
                    let name: String = r.try_get("ROUTINE_NAME")?;
                    let verb = if kind.eq_ignore_ascii_case("PROCEDURE") {
                        "PROCEDURE"
                    } else {
                        "FUNCTION"
                    };
                    let show = format!(
                        "SHOW CREATE {verb} {}.{}",
                        quote_ident(DriverKind::Mysql, &schema),
                        quote_ident(DriverKind::Mysql, &name)
                    );
                    let create = sqlx::raw_sql(&show)
                        .fetch_one(p)
                        .await
                        .ok()
                        .and_then(|row| row.try_get_unchecked::<String, _>(2).ok());
                    catalog.objects.push(ManagedObject {
                        kind: kind.to_ascii_lowercase(),
                        identity: None,
                        schema: Some(schema.clone()),
                        name: name.clone(),
                        table: None,
                        definition: create,
                        drop_sql: Some(format!(
                            "DROP {verb} IF EXISTS {}.{}",
                            quote_ident(DriverKind::Mysql, &schema),
                            quote_ident(DriverKind::Mysql, &name)
                        )),
                    });
                }
            }
            let triggers = if let Some(table) = table {
                // Catalog names come from the table tree. Compare their exact
                // bytes so an information_schema case-insensitive collation
                // cannot include a differently named table or database.
                sqlx::query("SELECT CAST(TRIGGER_SCHEMA AS CHAR) AS TRIGGER_SCHEMA, CAST(TRIGGER_NAME AS CHAR) AS TRIGGER_NAME, CAST(EVENT_OBJECT_TABLE AS CHAR) AS EVENT_OBJECT_TABLE, CAST(ACTION_STATEMENT AS CHAR) AS ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE CAST(TRIGGER_SCHEMA AS BINARY)=CAST(COALESCE(NULLIF(?,''),DATABASE()) AS BINARY) AND CAST(EVENT_OBJECT_TABLE AS BINARY)=CAST(? AS BINARY) ORDER BY TRIGGER_NAME")
                    .bind(schema).bind(table).fetch_all(p).await?
            } else {
                sqlx::query("SELECT CAST(TRIGGER_SCHEMA AS CHAR) AS TRIGGER_SCHEMA, CAST(TRIGGER_NAME AS CHAR) AS TRIGGER_NAME, CAST(EVENT_OBJECT_TABLE AS CHAR) AS EVENT_OBJECT_TABLE, CAST(ACTION_STATEMENT AS CHAR) AS ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=COALESCE(NULLIF(?,''),DATABASE()) ORDER BY TRIGGER_NAME")
                    .bind(schema).fetch_all(p).await?
            };
            for r in triggers {
                let schema: String = r.try_get("TRIGGER_SCHEMA")?;
                let name: String = r.try_get("TRIGGER_NAME")?;
                let show = format!(
                    "SHOW CREATE TRIGGER {}.{}",
                    quote_ident(DriverKind::Mysql, &schema),
                    quote_ident(DriverKind::Mysql, &name)
                );
                let create = sqlx::raw_sql(&show)
                    .fetch_one(p)
                    .await
                    .ok()
                    .and_then(|row| row.try_get_unchecked::<String, _>(2).ok());
                catalog.objects.push(ManagedObject {
                    kind: "trigger".into(),
                    identity: None,
                    schema: Some(schema.clone()),
                    name: name.clone(),
                    table: r.try_get("EVENT_OBJECT_TABLE").ok(),
                    definition: create,
                    drop_sql: Some(format!(
                        "DROP TRIGGER IF EXISTS {}.{}",
                        quote_ident(DriverKind::Mysql, &schema),
                        quote_ident(DriverKind::Mysql, &name)
                    )),
                });
            }
            if table.is_none() {
                let user_grants = sqlx::query("SELECT GRANTEE, CONCAT(PRIVILEGE_TYPE, ' ON *.*') AS PRIVILEGE FROM information_schema.USER_PRIVILEGES UNION ALL SELECT GRANTEE, CONCAT(PRIVILEGE_TYPE, ' ON ', TABLE_SCHEMA, '.*') FROM information_schema.SCHEMA_PRIVILEGES UNION ALL SELECT GRANTEE, CONCAT(PRIVILEGE_TYPE, ' ON ', TABLE_SCHEMA, '.', TABLE_NAME) FROM information_schema.TABLE_PRIVILEGES ORDER BY GRANTEE")
                .fetch_all(p).await?;
                let mut user_map: HashMap<(String, String), Vec<String>> = HashMap::new();
                for r in user_grants {
                    let grantee: String = r.try_get("GRANTEE")?;
                    let (user, host) = split_mysql_grantee(&grantee);
                    user_map
                        .entry((user, host))
                        .or_default()
                        .push(r.try_get("PRIVILEGE")?);
                }
                for ((name, host), grants) in user_map {
                    catalog.users.push(ManagedUser {
                        name,
                        host: Some(host),
                        grants,
                    });
                }
            }
            catalog.supported = if table.is_some() {
                vec!["trigger".into()]
            } else {
                vec![
                    "function".into(),
                    "procedure".into(),
                    "trigger".into(),
                    "user".into(),
                    "permission".into(),
                    "index".into(),
                    "foreign_key".into(),
                ]
            };
        }
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Manage database objects"),
    }
    Ok(catalog)
}

pub async fn apply_object_definition(
    pool: &DbPool,
    definition: &str,
    drop_sql: Option<&str>,
) -> AppResult<()> {
    let sql = drop_sql.unwrap_or(definition).trim();
    if sql.is_empty() {
        return Err(AppError::msg("object definition cannot be empty"));
    }
    if definition.len() > 1024 * 1024 {
        return Err(AppError::msg("object definition exceeds 1 MiB"));
    }
    execute_ddl(pool, sql).await
}

fn mysql_literal(value: &str, no_backslash_escapes: bool) -> String {
    let escaped = if no_backslash_escapes {
        value.to_owned()
    } else {
        value.replace('\\', "\\\\")
    };
    format!("'{}'", escaped.replace('\'', "''"))
}
async fn mysql_literal_statement(
    pool: &sqlx::MySqlPool,
    build: impl FnOnce(bool) -> String + Send,
) -> AppResult<()> {
    let mut connection = pool.acquire().await?;
    let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode")
        .fetch_one(&mut *connection)
        .await?;
    let sql = build(mode.split(',').any(|mode| mode == "NO_BACKSLASH_ESCAPES"));
    sqlx::Executor::execute(&mut *connection, sql.as_str()).await?;
    Ok(())
}

pub async fn apply_user(
    pool: &DbPool,
    name: &str,
    host: Option<&str>,
    password: Option<&str>,
    drop: bool,
) -> AppResult<()> {
    clean_ident(name, "user name")?;
    if let DbPool::Mysql(mysql) = pool {
        if !drop && password.is_none() {
            return Err(AppError::msg("a password is required to create a user"));
        }
        return mysql_literal_statement(mysql, |mode| {
            let account = format!(
                "{}@{}",
                mysql_literal(name, mode),
                mysql_literal(host.unwrap_or("%"), mode)
            );
            if drop {
                format!("DROP USER {account}")
            } else {
                format!(
                    "CREATE USER {account} IDENTIFIED BY {}",
                    mysql_literal(password.unwrap_or_default(), mode)
                )
            }
        })
        .await;
    }
    let sql = match pool.driver() {
        DriverKind::Postgres => {
            let user = quote_ident(DriverKind::Postgres, name);
            if drop {
                format!("DROP ROLE {user}")
            } else {
                let password = password.ok_or_else(|| {
                    AppError::msg("a password is required to create a login role")
                })?;
                format!(
                    "CREATE ROLE {user} LOGIN PASSWORD E'{}'",
                    password.replace('\\', "\\\\").replace('\'', "''")
                )
            }
        }
        DriverKind::Mysql => {
            let host = host.filter(|s| !s.is_empty()).unwrap_or("%");
            if drop {
                format!(
                    "DROP USER '{}'@'{}'",
                    name.replace('\'', "''"),
                    host.replace('\'', "''")
                )
            } else {
                let password = password
                    .ok_or_else(|| AppError::msg("a password is required to create a user"))?;
                format!(
                    "CREATE USER '{}'@'{}' IDENTIFIED BY '{}'",
                    name.replace('\'', "''"),
                    host.replace('\'', "''"),
                    password.replace('\'', "''")
                )
            }
        }
        DriverKind::Sqlite => return Err(AppError::msg("SQLite does not support database users")),
        DriverKind::Redis => return crate::db::redis_ops::unsupported("Manage users"),
    };
    execute_ddl(pool, &sql).await
}

pub async fn apply_grants(
    pool: &DbPool,
    grantee: &str,
    host: Option<&str>,
    database: &str,
    object: Option<&str>,
    privileges: &[String],
    grant: bool,
) -> AppResult<()> {
    clean_ident(grantee, "grantee")?;
    clean_ident(database, "database")?;
    if let Some(object) = object {
        clean_ident(object, "object")?;
    }
    if privileges.is_empty() {
        return Err(AppError::msg("select at least one privilege"));
    }
    let allowed: &[&str] = match pool.driver() {
        DriverKind::Postgres if object.is_some() => &[
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "TRUNCATE",
            "REFERENCES",
            "TRIGGER",
            "ALL PRIVILEGES",
        ],
        DriverKind::Postgres => &["CREATE", "CONNECT", "TEMPORARY", "ALL PRIVILEGES"],
        DriverKind::Mysql => &[
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "CREATE",
            "DROP",
            "ALTER",
            "INDEX",
            "REFERENCES",
            "EXECUTE",
            "TRIGGER",
            "CREATE VIEW",
            "SHOW VIEW",
            "ALL PRIVILEGES",
        ],
        _ => &[],
    };
    let mut normalized = Vec::new();
    for privilege in privileges {
        let p = privilege.trim().to_ascii_uppercase().replace('_', " ");
        let p = p.split_whitespace().collect::<Vec<_>>().join(" ");
        if !allowed.contains(&p.as_str()) {
            return Err(AppError::msg(format!("unsupported privilege: {p}")));
        }
        if !normalized.contains(&p) {
            normalized.push(p);
        }
    }
    let action = if grant { "GRANT" } else { "REVOKE" };
    if let DbPool::Mysql(mysql) = pool {
        return mysql_literal_statement(mysql, |mode| {
            let target = match object {
                Some(object) => qualified(DriverKind::Mysql, Some(database), object),
                None => format!("{}.*", quote_ident(DriverKind::Mysql, database)),
            };
            format!(
                "{action} {} ON {target} {} {}@{}",
                normalized.join(", "),
                if grant { "TO" } else { "FROM" },
                mysql_literal(grantee, mode),
                mysql_literal(host.unwrap_or("%"), mode)
            )
        })
        .await;
    }
    let sql = match pool.driver() {
        DriverKind::Postgres => {
            let target = match object {
                Some(obj) => format!(
                    "ON TABLE {}",
                    qualified(DriverKind::Postgres, Some(database), obj)
                ),
                None => format!(
                    "ON DATABASE {}",
                    quote_ident(DriverKind::Postgres, database)
                ),
            };
            format!(
                "{action} {} {target} {} {}",
                normalized.join(", "),
                if grant { "TO" } else { "FROM" },
                quote_ident(DriverKind::Postgres, grantee)
            )
        }
        DriverKind::Mysql => {
            let target = match object {
                Some(obj) => format!(
                    "{}.{}",
                    quote_ident(DriverKind::Mysql, database),
                    quote_ident(DriverKind::Mysql, obj)
                ),
                None => format!("{}.*", quote_ident(DriverKind::Mysql, database)),
            };
            let host = host.filter(|s| !s.is_empty()).unwrap_or("%");
            format!(
                "{action} {} ON {target} {} '{}'@'{}'",
                normalized.join(", "),
                if grant { "TO" } else { "FROM" },
                grantee.replace('\'', "''"),
                host.replace('\'', "''")
            )
        }
        DriverKind::Sqlite => {
            return Err(AppError::msg("SQLite does not support database privileges"))
        }
        DriverKind::Redis => return crate::db::redis_ops::unsupported("Manage privileges"),
    };
    execute_ddl(pool, &sql).await
}

pub async fn list_index_metadata(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<Vec<IndexInfo>> {
    Ok(design::describe(pool, schema, table).await?.indexes)
}

pub async fn replace_object_definition(
    pool: &DbPool,
    original: &str,
    drop_sql: &str,
    replacement: &str,
) -> AppResult<()> {
    if original.trim().is_empty()
        || drop_sql.trim().is_empty()
        || replacement.trim().is_empty()
        || replacement.len() > 1024 * 1024
    {
        return Err(AppError::msg(
            "provide the original, drop, and replacement definitions (at most 1 MiB)",
        ));
    }
    match pool {
        DbPool::Sqlite(p) => {
            let mut tx = p.begin().await?;
            sqlx::Executor::execute(&mut *tx, drop_sql).await?;
            sqlx::Executor::execute(&mut *tx, replacement).await?;
            tx.commit().await?;
        }
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await?;
            sqlx::Executor::execute(&mut *tx, drop_sql).await?;
            sqlx::Executor::execute(&mut *tx, replacement).await?;
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            let mut connection = p.acquire().await?;
            connection.close_on_drop();
            sqlx::Executor::execute(&mut *connection, drop_sql).await?;
            if let Err(error) = sqlx::Executor::execute(&mut *connection, replacement).await {
                return match sqlx::Executor::execute(&mut *connection, original).await {
                    Ok(_) => Err(AppError::msg(format!("replacement failed; original definition restored (review routine grants): {error}"))),
                    Err(restore) => Err(AppError::msg(format!("replacement failed and the original could not be restored: {error}; restore error: {restore}"))),
                };
            }
        }
        DbPool::Redis(_) => return Err(AppError::msg("SQL objects are not supported for Redis")),
    }
    Ok(())
}

// Scope is explicit in the permissions form; legacy callers keep their table/database behavior.
#[allow(clippy::too_many_arguments)]
pub async fn apply_scoped_grants(
    pool: &DbPool,
    grantee: &str,
    host: Option<&str>,
    database: &str,
    object: Option<&str>,
    privileges: &[String],
    grant: bool,
    scope: Option<&str>,
) -> AppResult<()> {
    match scope {
        Some("schema") if pool.driver() == DriverKind::Postgres => {
            clean_ident(grantee, "grantee")?;
            clean_ident(database, "schema")?;
            if privileges.is_empty()
                || privileges
                    .iter()
                    .any(|p| !["USAGE", "CREATE", "ALL PRIVILEGES"].contains(&p.as_str()))
            {
                return Err(AppError::msg(
                    "schema privileges must be USAGE, CREATE, or ALL PRIVILEGES",
                ));
            }
            let sql = format!(
                "{} {} ON SCHEMA {} {} {}",
                if grant { "GRANT" } else { "REVOKE" },
                privileges.join(", "),
                quote_ident(DriverKind::Postgres, database),
                if grant { "TO" } else { "FROM" },
                quote_ident(DriverKind::Postgres, grantee)
            );
            execute_ddl(pool, &sql).await
        }
        Some("database") => {
            apply_grants(pool, grantee, host, database, None, privileges, grant).await
        }
        Some("table") if object.is_some_and(|object| !object.trim().is_empty()) => {
            apply_grants(pool, grantee, host, database, object, privileges, grant).await
        }
        None => apply_grants(pool, grantee, host, database, object, privileges, grant).await,
        _ => Err(AppError::msg(
            "choose a supported privilege scope and object",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sqlite_create_table_parser_preserves_literals_and_nested_commas() {
        let ddl = "CREATE TABLE \"items\" (id INTEGER PRIMARY KEY, value TEXT DEFAULT 'x,y', CHECK(length(value) > 0), CONSTRAINT fk_old FOREIGN KEY(parent) REFERENCES parent(id)) STRICT";
        let (start, end) = create_table_body(ddl).unwrap();
        let clauses = split_table_clauses(&ddl[start..end]).unwrap();
        assert_eq!(clauses.len(), 4);
        assert!(is_table_foreign_key(clauses[3]));
        assert_eq!(
            replace_create_table_name(ddl, "temp_items")
                .unwrap()
                .split('(')
                .next()
                .unwrap()
                .trim_end(),
            "CREATE TABLE \"temp_items\""
        );
    }

    #[test]
    fn foreign_key_actions_are_allowlisted_and_columns_must_pair() {
        let mut fk = ForeignKeyDefinition {
            name: "fk_item_parent".into(),
            columns: vec!["parent_id".into()],
            referenced_schema: None,
            referenced_table: "parents".into(),
            referenced_columns: vec!["id".into()],
            on_update: Some("CASCADE".into()),
            on_delete: Some("SET NULL".into()),
        };
        assert!(validate_foreign_keys(DriverKind::Sqlite, &[fk.clone()]).is_ok());
        fk.on_delete = Some("CASCADE; DROP TABLE parents".into());
        assert!(validate_foreign_keys(DriverKind::Sqlite, &[fk]).is_err());
    }

    #[tokio::test]
    async fn sqlite_foreign_key_rebuild_preserves_rows_checks_indexes_triggers_and_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("constraints.db");
        let sqlite = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&sqlite)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
            .execute(&sqlite)
            .await
            .unwrap();
        sqlx::query("INSERT INTO parent VALUES (1)")
            .execute(&sqlite)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE child (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, note TEXT CHECK(length(note)>0), CONSTRAINT fk_parent FOREIGN KEY(parent_id) REFERENCES parent(id) ON DELETE RESTRICT)")
            .execute(&sqlite).await.unwrap();
        sqlx::query("CREATE INDEX idx_child_note ON child(note)")
            .execute(&sqlite)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER child_touch AFTER UPDATE ON child BEGIN UPDATE child SET note=NEW.note WHERE id=NEW.id; END")
            .execute(&sqlite).await.unwrap();
        sqlx::query("INSERT INTO child (id,parent_id,note) VALUES (17,1,'saved')")
            .execute(&sqlite)
            .await
            .unwrap();

        let pool = DbPool::Sqlite(sqlite.clone());
        let description = design::describe(&pool, None, "child").await.unwrap();
        let mut changed = ForeignKeyDefinition::from(&description.foreign_keys[0]);
        changed.name = "fk_parent".into();
        changed.on_delete = Some("CASCADE".into());
        apply_foreign_key_changes(&pool, None, "child", &[changed.clone()])
            .await
            .unwrap();

        let delete_action: String =
            sqlx::query_scalar("SELECT on_delete FROM pragma_foreign_key_list('child')")
                .fetch_one(&sqlite)
                .await
                .unwrap();
        assert_eq!(delete_action, "CASCADE");
        let row: (i64, String) = sqlx::query_as("SELECT id,note FROM child")
            .fetch_one(&sqlite)
            .await
            .unwrap();
        assert_eq!(row, (17, "saved".into()));
        let seq: i64 = sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name='child'")
            .fetch_one(&sqlite)
            .await
            .unwrap();
        assert_eq!(seq, 17);
        let preserved: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE (type='index' AND name='idx_child_note') OR (type='trigger' AND name='child_touch') OR (type='table' AND name='child' AND sql LIKE '%CHECK%')")
            .fetch_one(&sqlite).await.unwrap();
        assert_eq!(preserved, 3);

        let mut invalid = changed;
        invalid.referenced_table = "absent_parent".into();
        assert!(apply_foreign_key_changes(&pool, None, "child", &[invalid])
            .await
            .is_err());
        let action_after_failure: String =
            sqlx::query_scalar("SELECT on_delete FROM pragma_foreign_key_list('child')")
                .fetch_one(&sqlite)
                .await
                .unwrap();
        assert_eq!(
            action_after_failure, "CASCADE",
            "failed rebuild must roll back to the prior constraint"
        );
        let row_after_failure: String = sqlx::query_scalar("SELECT note FROM child WHERE id=17")
            .fetch_one(&sqlite)
            .await
            .unwrap();
        assert_eq!(row_after_failure, "saved");
        sqlite.close().await;
    }

    #[tokio::test]
    async fn sqlite_failed_index_replacement_keeps_the_original_index() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE indexed (a INT, b INT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE INDEX idx_keep ON indexed(a)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO indexed VALUES (1,1),(1,2)")
            .execute(&pool)
            .await
            .unwrap();
        let pool = DbPool::Sqlite(pool.clone());
        let change = IndexChange::Replace {
            old_name: "idx_keep".into(),
            name: "idx_keep".into(),
            columns: vec!["a".into()],
            unique: true,
            method: None,
            prefix_lengths: vec![],
        };
        assert!(apply_index_change(&pool, None, "indexed", &change)
            .await
            .is_err());
        let sql: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_keep'",
        )
        .fetch_one(match &pool {
            DbPool::Sqlite(p) => p,
            _ => unreachable!(),
        })
        .await
        .unwrap();
        assert!(
            sql.contains("ON indexed(a)"),
            "a failed replacement must leave the old index intact"
        );
    }

    #[tokio::test]
    async fn sqlite_refuses_to_drop_unrepresented_deferrable_foreign_key_options() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deferrable.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE parent (id INT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE child (parent_id INT, CONSTRAINT fk_parent FOREIGN KEY(parent_id) REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)").execute(&pool).await.unwrap();
        let db = DbPool::Sqlite(pool.clone());
        let current = design::describe(&db, None, "child").await.unwrap();
        let key = ForeignKeyDefinition::from(&current.foreign_keys[0]);
        let error = apply_foreign_key_changes(&db, None, "child", &[key])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("deferrability"));
        let ddl: String =
            sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type='table' AND name='child'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(ddl.contains("DEFERRABLE INITIALLY DEFERRED"));
        pool.close().await;
    }
}
