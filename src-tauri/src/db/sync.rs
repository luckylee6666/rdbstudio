//! Bounded cross-database structure comparison, row synchronization, and search.
//! Values use the same JSON decoding rules as the query grid (large integers
//! and decimals stay strings, so they are never rounded by JavaScript).

use crate::db::data::{self, Edit, EditBatch};
use crate::db::design::{self, TableDescription};
use crate::db::exec::{self, QueryResult};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

pub const MAX_SYNC_ROWS: usize = 10_000;
pub const MAX_SYNC_BYTES: usize = 16 * 1024 * 1024;
const MAX_SYNC_BINARY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SEARCH_TABLES: usize = 300;
pub const MAX_SEARCH_HITS: usize = 500;
pub const MAX_SEARCH_BYTES: usize = 4 * 1024 * 1024;
const PAGE_SIZE: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncRequest {
    pub source_id: String,
    pub target_id: String,
    pub source_schema: Option<String>,
    pub source_table: String,
    pub target_schema: Option<String>,
    pub target_table: String,
    /// Include target rows missing from source in the preview; deletion still
    /// requires the explicit `mirror` apply policy.
    #[serde(default)]
    pub compare_deletes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ColumnChange {
    pub name: String,
    pub source_type: Option<String>,
    pub target_type: Option<String>,
    pub kind: String,
    pub supported: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StructurePlan {
    pub source_table: String,
    pub target_table: String,
    pub target_exists: bool,
    pub changes: Vec<ColumnChange>,
    pub statements: Vec<String>,
    pub supported: bool,
    pub reason: Option<String>,
    pub ddl_transactional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncCounts {
    pub inserts: usize,
    pub updates: usize,
    pub deletes: usize,
    pub unchanged: usize,
    pub sample_conflict_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncPreview {
    pub token: String,
    pub source_driver: DriverKind,
    pub target_driver: DriverKind,
    pub structure: StructurePlan,
    pub data_supported: bool,
    pub data_reason: Option<String>,
    pub counts: SyncCounts,
    pub rows_examined: usize,
    pub bytes_examined: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    InsertOnly,
    Overwrite,
    Mirror,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncReport {
    pub inserted: u64,
    pub updated: u64,
    pub deleted: u64,
    pub structure_statements: usize,
    pub structure_applied_before_data: bool,
    pub transactional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchRequest {
    pub connection_id: String,
    #[serde(default)]
    pub schema: Option<String>,
    /// Empty means every supported base table in the selected schema.
    #[serde(default)]
    pub tables: Vec<String>,
    pub text: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchHit {
    pub schema: Option<String>,
    pub table: String,
    pub column: String,
    pub primary_key: Vec<(String, Json)>,
    pub value: Json,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub tables_searched: usize,
    pub truncated: bool,
    pub bytes: usize,
}

#[derive(Debug, Clone)]
pub struct SyncPlan {
    pub request: SyncRequest,
    pub structure: StructurePlan,
    pub source_description: TableDescription,
    pub target_description: Option<TableDescription>,
    pub source_rows: BTreeMap<String, Vec<Json>>,
    pub target_rows: BTreeMap<String, Vec<Json>>,
    pub source_driver: DriverKind,
    pub target_driver: DriverKind,
    pub digest: u64,
    pub source_digest: u64,
    pub rows_examined: usize,
    pub bytes_examined: usize,
    pub counts: SyncCounts,
    pub data_supported: bool,
    pub data_reason: Option<String>,
}

pub async fn preview(
    source: &DbPool,
    target: &DbPool,
    mut request: SyncRequest,
) -> AppResult<SyncPlan> {
    if source.driver() == DriverKind::Postgres
        && request
            .source_schema
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        request.source_schema = Some("public".into());
    }
    if target.driver() == DriverKind::Postgres
        && request
            .target_schema
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        request.target_schema = Some("public".into());
    }
    validate_request(source, target, &request)?;
    if table_kind(
        source,
        request.source_schema.as_deref(),
        &request.source_table,
    )
    .await?
        != Some("table".into())
    {
        return Err(AppError::msg(
            "source object is missing or is not a base table",
        ));
    }
    let source_description = design::describe(
        source,
        request.source_schema.as_deref(),
        &request.source_table,
    )
    .await?;
    let target_kind = table_kind(
        target,
        request.target_schema.as_deref(),
        &request.target_table,
    )
    .await?;
    let target_exists = target_kind.as_deref() == Some("table");
    if target_kind.is_some() && !target_exists {
        return Err(AppError::msg(
            "target object exists but is not a base table",
        ));
    }
    let target_description = if target_exists {
        Some(
            design::describe(
                target,
                request.target_schema.as_deref(),
                &request.target_table,
            )
            .await?,
        )
    } else {
        None
    };
    let mut structure = structure_plan(
        &source_description,
        target_description.as_ref(),
        source.driver(),
        target.driver(),
        request.target_schema.as_deref(),
        &request.target_table,
    );
    let (hidden_features, feature_notes) = unmodeled_features(
        source,
        request.source_schema.as_deref(),
        &request.source_table,
    )
    .await?;
    structure
        .changes
        .extend(feature_notes.iter().map(|note| ColumnChange {
            name: "table feature".into(),
            source_type: None,
            target_type: None,
            kind: "not_copied".into(),
            supported: false,
            detail: Some(note.clone()),
        }));
    let source_nontransactional = match source {
        DbPool::Mysql(pool) => {
            !mysql_table_is_transactional(
                pool,
                request.source_schema.as_deref(),
                &request.source_table,
            )
            .await?
        }
        _ => false,
    };
    let target_nontransactional = match (target, target_description.is_some()) {
        (DbPool::Mysql(pool), true) => !mysql_table_is_transactional(
            pool,
            request.target_schema.as_deref(),
            &request.target_table,
        )
        .await?,
        _ => false,
    };
    if !hidden_features.is_empty() {
        structure.supported = false;
        structure.statements.clear();
        let reason = hidden_features.join("; ");
        structure
            .changes
            .extend(hidden_features.iter().map(|feature| ColumnChange {
                name: "table feature".into(),
                source_type: None,
                target_type: None,
                kind: "unmodeled_feature".into(),
                supported: false,
                detail: Some(feature.clone()),
            }));
        structure.reason = Some(match structure.reason.take() {
            Some(existing) => format!("{}; {}", existing, reason),
            None => reason,
        });
    }
    let source_columns: Vec<String> = source_description
        .columns
        .iter()
        .map(|c| c.name.clone())
        .collect();
    let mut data_reason = if source_description.primary_key.is_empty() {
        Some("data synchronization requires a source primary key".into())
    } else if !hidden_features.is_empty() {
        Some(hidden_features.join("; "))
    } else if (source.driver() == DriverKind::Mysql && has_mysql_timestamp(&source_description))
        || (target.driver() == DriverKind::Mysql
            && (target_description.as_ref().is_some_and(has_mysql_timestamp)
                || has_timezone_timestamp(&source_description)))
    {
        Some("MySQL TIMESTAMP session-time-zone normalization is not guaranteed".into())
    } else if source_nontransactional {
        Some("source table engine does not support consistent snapshot reads".into())
    } else if target_nontransactional {
        Some("target table engine does not support transactional writes".into())
    } else if target_description.is_none() && !structure.supported {
        structure.reason.clone()
    } else {
        None
    };
    let target_columns: Vec<String> = source_description
        .columns
        .iter()
        .filter(|c| {
            target_description
                .as_ref()
                .is_some_and(|d| d.columns.iter().any(|tc| tc.name == c.name))
                || target_description.is_none()
        })
        .map(|c| c.name.clone())
        .collect();
    let mut source_rows = BTreeMap::new();
    let mut target_rows = BTreeMap::new();
    let mut can_read_data = data_reason.is_none()
        && target_description.as_ref().is_none_or(|target_desc| {
            target_desc.primary_key == source_description.primary_key
                && source_description.columns.iter().all(|col| {
                    target_desc
                        .columns
                        .iter()
                        .find(|tc| tc.name == col.name)
                        .is_some_and(|tc| {
                            column_data_compatible(col, tc)
                                && (!effectively_nullable(col) || effectively_nullable(tc))
                        })
                })
                && target_desc.columns.iter().all(|col| {
                    source_description
                        .columns
                        .iter()
                        .any(|sc| sc.name == col.name)
                        || col.nullable
                        || col.default.is_some()
                        || col.is_auto_increment
                })
        });
    if !can_read_data && data_reason.is_none() {
        data_reason =
            Some("source and target primary keys or common column types are incompatible".into());
    }
    if can_read_data {
        source_rows = read_rows(
            source,
            request.source_schema.as_deref(),
            &request.source_table,
            &source_description,
            &source_columns,
        )
        .await?;
    }
    if can_read_data {
        target_rows = if let Some(description) = target_description.as_ref() {
            let selected = target_columns
                .iter()
                .filter(|name| description.columns.iter().any(|c| &c.name == *name))
                .cloned()
                .collect::<Vec<_>>();
            read_rows(
                target,
                request.target_schema.as_deref(),
                &request.target_table,
                description,
                &selected,
            )
            .await?
        } else {
            BTreeMap::new()
        };
    }
    if can_read_data
        && (rows_exceed_binary_limit(&source_description, &source_columns, &source_rows)
            || target_description.as_ref().is_some_and(|description| {
                rows_exceed_binary_limit(description, &target_columns, &target_rows)
            }))
    {
        can_read_data = false;
        data_reason = Some(format!(
            "binary cells exceed the {} MiB per-value transfer limit",
            MAX_SYNC_BINARY_BYTES / 1024 / 1024
        ));
    }
    let source_names: Vec<String> = source_description
        .columns
        .iter()
        .map(|c| c.name.clone())
        .collect();
    let target_name_to_index: HashMap<&str, usize> = target_columns
        .iter()
        .enumerate()
        .map(|(i, c)| (c.as_str(), i))
        .collect();
    let mut inserts = 0;
    let mut updates = 0;
    let mut deletes = 0;
    let mut unchanged = 0;
    let mut sample_conflict_keys = Vec::new();
    let mut digest = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    for (key, row) in &source_rows {
        key.hash(&mut digest);
        serde_json::to_string(row)?.hash(&mut digest);
        match target_rows.get(key) {
            None => inserts += 1,
            Some(existing) => {
                let differs = source_names.iter().enumerate().any(|(idx, name)| {
                    target_name_to_index
                        .get(name.as_str())
                        .and_then(|target_idx| existing.get(*target_idx))
                        .is_some_and(|target_value| row.get(idx) != Some(target_value))
                });
                if differs {
                    updates += 1;
                    if sample_conflict_keys.len() < 20 {
                        sample_conflict_keys.push(sample_key(key));
                    }
                } else {
                    unchanged += 1;
                }
            }
        }
    }
    let mut source_hasher = std::collections::hash_map::DefaultHasher::new();
    for (key, row) in &source_rows {
        key.hash(&mut source_hasher);
        serde_json::to_string(row)?.hash(&mut source_hasher);
    }
    for (key, row) in &target_rows {
        key.hash(&mut digest);
        serde_json::to_string(row)?.hash(&mut digest);
    }
    if request.compare_deletes {
        for key in target_rows.keys() {
            key.hash(&mut digest);
            if !source_rows.contains_key(key) {
                deletes += 1;
                if sample_conflict_keys.len() < 20 {
                    sample_conflict_keys.push(sample_key(key));
                }
            }
        }
    }
    serde_json::to_string(&structure)?.hash(&mut digest);
    let rows_examined = source_rows.len() + target_rows.len();
    let bytes_examined = estimate_bytes(&source_rows)? + estimate_bytes(&target_rows)?;
    Ok(SyncPlan {
        request,
        structure,
        source_description,
        target_description,
        source_rows,
        target_rows,
        source_driver: source.driver(),
        target_driver: target.driver(),
        digest: digest.finish(),
        source_digest: source_hasher.finish(),
        rows_examined,
        bytes_examined,
        counts: SyncCounts {
            inserts,
            updates,
            deletes,
            unchanged,
            sample_conflict_keys,
        },
        data_supported: can_read_data,
        data_reason,
    })
}

pub async fn apply_structure(target: &DbPool, plan: &StructurePlan) -> AppResult<usize> {
    if !plan.supported {
        return Err(AppError::msg(
            plan.reason
                .as_deref()
                .unwrap_or("structure changes are not supported"),
        ));
    }
    if plan.statements.is_empty() {
        return Ok(0);
    }
    match target {
        DbPool::Sqlite(pool) => {
            let mut tx = pool.begin().await?;
            for statement in &plan.statements {
                sqlx::query(statement).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        DbPool::Postgres(pool) => {
            let mut tx = pool.begin().await?;
            for statement in &plan.statements {
                sqlx::query(statement).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        DbPool::Mysql(pool) => {
            // MySQL commits DDL implicitly. Execute the reviewed statement list
            // in order and report this non-atomic boundary to the UI.
            for statement in &plan.statements {
                sqlx::query(statement).execute(pool).await?;
            }
        }
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Structure synchronization"),
    }
    Ok(plan.statements.len())
}

pub async fn apply_data(
    target: &DbPool,
    plan: &SyncPlan,
    policy: ConflictPolicy,
) -> AppResult<(u64, u64, u64)> {
    if !plan.data_supported {
        return Err(AppError::msg(
            plan.data_reason
                .as_deref()
                .unwrap_or("data synchronization is not supported"),
        ));
    }
    if plan.target_description.is_none() && !plan.structure.supported {
        return Err(AppError::msg(
            plan.structure
                .reason
                .as_deref()
                .unwrap_or("target structure is incompatible"),
        ));
    }
    let source_cols: Vec<String> = plan
        .source_description
        .columns
        .iter()
        .map(|c| c.name.clone())
        .collect();
    let target_desc = plan
        .target_description
        .as_ref()
        .unwrap_or(&plan.source_description);
    let target_cols: Vec<String> = target_desc
        .columns
        .iter()
        .filter(|tc| source_cols.contains(&tc.name))
        .map(|c| c.name.clone())
        .collect();
    let source_indexes: HashMap<&str, usize> = source_cols
        .iter()
        .enumerate()
        .map(|(i, n)| (n.as_str(), i))
        .collect();
    let pk_set: std::collections::HashSet<&str> = plan
        .source_description
        .primary_key
        .iter()
        .map(String::as_str)
        .collect();
    let target_indexes: HashMap<&str, usize> = target_cols
        .iter()
        .enumerate()
        .map(|(i, name)| (name.as_str(), i))
        .collect();
    let mut edits = Vec::new();
    let mut inserted = 0u64;
    let mut updated = 0u64;
    let mut deleted = 0u64;
    for (key, row) in &plan.source_rows {
        let values: Vec<(String, Json)> = target_cols
            .iter()
            .filter_map(|name| {
                source_indexes
                    .get(name.as_str())
                    .and_then(|idx| row.get(*idx))
                    .map(|value| {
                        edit_bind_value(target_desc, name, value).map(|bound| (name.clone(), bound))
                    })
            })
            .collect::<AppResult<_>>()?;
        match plan.target_rows.get(key) {
            None => {
                edits.push(Edit::Insert { values });
                inserted += 1;
            }
            Some(target_row) if policy != ConflictPolicy::InsertOnly => {
                let set: Vec<(String, Json)> = values
                    .into_iter()
                    .filter(|(name, value)| {
                        !pk_set.contains(name.as_str())
                            && target_indexes
                                .get(name.as_str())
                                .and_then(|idx| target_row.get(*idx))
                                .is_some_and(|old| {
                                    edit_bind_value(target_desc, name, old)
                                        .is_ok_and(|bound| bound != *value)
                                })
                    })
                    .collect();
                if !set.is_empty() {
                    let guarded_pk: Vec<(String, Json)> = target_cols
                        .iter()
                        .enumerate()
                        .map(|(index, name)| {
                            edit_bind_value(target_desc, name, &target_row[index])
                                .map(|bound| (name.clone(), bound))
                        })
                        .collect::<AppResult<_>>()?;
                    edits.push(Edit::Update {
                        pk: guarded_pk,
                        set,
                    });
                    updated += 1;
                }
            }
            _ => {}
        }
    }
    if policy == ConflictPolicy::Mirror {
        for (key, row) in &plan.target_rows {
            if plan.source_rows.contains_key(key) {
                continue;
            }
            let pk: Vec<(String, Json)> = target_cols
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    edit_bind_value(target_desc, name, &row[index])
                        .map(|bound| (name.clone(), bound))
                })
                .collect::<AppResult<_>>()?;
            edits.push(Edit::Delete { pk });
            deleted += 1;
        }
    }
    if edits.is_empty() {
        return Ok((0, 0, 0));
    }
    let result = data::apply_synced_edits(
        target,
        &EditBatch {
            schema: plan.request.target_schema.clone(),
            table: plan.request.target_table.clone(),
            edits,
        },
    )
    .await?;
    if !result.ok {
        return Err(AppError::msg(result.error.unwrap_or_else(|| {
            "data synchronization transaction failed".into()
        })));
    }
    Ok((inserted, updated, deleted))
}

fn validate_request(source: &DbPool, target: &DbPool, request: &SyncRequest) -> AppResult<()> {
    // Copying into a new table on the same pool is valid. Keep a conservative
    // guard for equal names (including case aliases on SQLite/MySQL) so a
    // copy request cannot resolve back to its source through default schemas.
    if request.source_id == request.target_id
        && request.source_table.eq_ignore_ascii_case(&request.target_table)
    {
        return Err(AppError::msg("source and target table names must differ on the same connection"));
    }
    if request.source_table.trim().is_empty() || request.target_table.trim().is_empty() {
        return Err(AppError::msg("source and target table names are required"));
    }
    if source.driver() == DriverKind::Redis || target.driver() == DriverKind::Redis {
        return Err(AppError::msg(
            "Redis is not supported for relational synchronization",
        ));
    }
    Ok(())
}

async fn table_kind(pool: &DbPool, schema: Option<&str>, table: &str) -> AppResult<Option<String>> {
    match pool {
        DbPool::Sqlite(p) => sqlx::query_scalar(
            "SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table','view')",
        )
        .bind(table)
        .fetch_optional(p)
        .await
        .map_err(AppError::from),
        DbPool::Postgres(p) => sqlx::query_scalar(
            "SELECT CASE WHEN table_type = 'BASE TABLE' THEN 'table' ELSE lower(table_type) END \
             FROM information_schema.tables WHERE table_schema = COALESCE($1, 'public') \
               AND table_name = $2",
        )
        .bind(schema)
        .bind(table)
        .fetch_optional(p)
        .await
        .map_err(AppError::from),
        DbPool::Mysql(p) => sqlx::query_scalar(
            "SELECT CAST(CASE WHEN table_type = 'BASE TABLE' THEN 'table' ELSE lower(table_type) END AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci \
             FROM information_schema.tables WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
               AND table_name = ?",
        )
        .bind(schema.unwrap_or(""))
        .bind(table)
        .fetch_optional(p)
        .await
        .map_err(AppError::from),
        DbPool::Redis(_) => crate::db::redis_ops::unsupported("Relational table lookup"),
    }
}

async fn list_table_names(
    pool: &DbPool,
    schema: Option<&str>,
    limit: usize,
) -> AppResult<Vec<String>> {
    match pool {
        DbPool::Sqlite(p) => sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             ORDER BY name LIMIT ?",
        )
        .bind(limit as i64)
        .fetch_all(p)
        .await
        .map_err(AppError::from),
        DbPool::Postgres(p) => sqlx::query_scalar(
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = COALESCE($1, 'public') AND table_type = 'BASE TABLE' \
             ORDER BY table_name LIMIT $2",
        )
        .bind(schema)
        .bind(limit as i64)
        .fetch_all(p)
        .await
        .map_err(AppError::from),
        DbPool::Mysql(p) => sqlx::query_scalar(
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_type = 'BASE TABLE' \
             ORDER BY table_name LIMIT ?",
        )
        .bind(schema.unwrap_or(""))
        .bind(limit as u64)
        .fetch_all(p)
        .await
        .map_err(AppError::from),
        DbPool::Redis(_) => crate::db::redis_ops::unsupported("Relational table listing"),
    }
}

fn structure_plan(
    source: &TableDescription,
    target: Option<&TableDescription>,
    source_driver: DriverKind,
    target_driver: DriverKind,
    target_schema: Option<&str>,
    target_name: &str,
) -> StructurePlan {
    let mut changes = Vec::new();
    let mut statements = Vec::new();
    let mut unsupported = Vec::new();
    if target.is_none() {
        // Constraints that would need the rest of the target schema (FKs) or
        // engine-specific semantics (CHECK, comments) are listed for review
        // but do not stop a plain table copy.
        if source.comment.as_deref().is_some_and(|s| !s.is_empty())
            || source
                .columns
                .iter()
                .any(|c| c.comment.as_deref().is_some_and(|s| !s.is_empty()))
        {
            changes.push(ColumnChange {
                name: "COMMENTS".into(),
                source_type: Some("table / column comments".into()),
                target_type: None,
                kind: "not_copied".into(),
                supported: false,
                detail: Some("comments are not copied".into()),
            });
        }
        if !source.foreign_keys.is_empty() {
            changes.push(ColumnChange {
                name: "FOREIGN KEYS".into(),
                source_type: Some(format!("{} definitions", source.foreign_keys.len())),
                target_type: None,
                kind: "foreign_keys_not_copied".into(),
                supported: false,
                detail: Some("foreign keys are not copied; recreate them once referenced tables exist".into()),
            });
        }
        if !source.check_constraints.is_empty() {
            changes.push(ColumnChange {
                name: "CHECK CONSTRAINTS".into(),
                source_type: Some(format!("{} definitions", source.check_constraints.len())),
                target_type: None,
                kind: "checks_not_copied".into(),
                supported: false,
                detail: Some("check constraints are not copied".into()),
            });
        }
        for col in &source.columns {
            match target_type(source_driver, target_driver, col) {
                Ok(ty) => changes.push(ColumnChange {
                    name: col.name.clone(),
                    source_type: Some(col.data_type.clone()),
                    target_type: Some(ty),
                    kind: "create_column".into(),
                    supported: true,
                    detail: None,
                }),
                Err(e) => unsupported.push(format!("column {}: {}", col.name, e)),
            }
        }
        let mut index_statements = Vec::new();
        for index in source.indexes.iter().filter(|i| !i.is_primary) {
            let kind_label = if index.is_unique { "UNIQUE INDEX" } else { "INDEX" };
            match index_create_sql(source, index, source_driver, target_driver, target_schema, target_name) {
                Ok(sql) => {
                    index_statements.push(sql);
                    changes.push(ColumnChange {
                        name: index.name.clone(),
                        source_type: Some(index.columns.join(", ")),
                        target_type: Some(kind_label.into()),
                        kind: "create_index".into(),
                        supported: true,
                        detail: None,
                    });
                }
                Err(reason) => changes.push(ColumnChange {
                    name: index.name.clone(),
                    source_type: Some(index.columns.join(", ")),
                    target_type: None,
                    kind: "index_not_copied".into(),
                    supported: false,
                    detail: Some(reason),
                }),
            }
        }
        if unsupported.is_empty() {
            match create_table_sql(
                source,
                source_driver,
                target_driver,
                target_schema,
                target_name,
            ) {
                Ok(sql) => {
                    statements.push(sql);
                    statements.extend(index_statements);
                }
                Err(e) => unsupported.push(e.to_string()),
            }
        }
        return StructurePlan {
            source_table: source.name.clone(),
            target_table: target_name.into(),
            target_exists: false,
            changes,
            statements,
            supported: unsupported.is_empty(),
            reason: (!unsupported.is_empty()).then(|| unsupported.join("; ")),
            ddl_transactional: target_driver != DriverKind::Mysql,
        };
    }
    let target = target.unwrap();
    let target_cols: HashMap<&str, &design::ColumnDetail> = target
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();
    let source_cols: HashMap<&str, &design::ColumnDetail> = source
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();
    for col in &source.columns {
        match target_cols.get(col.name.as_str()) {
            None => match target_type(source_driver, target_driver, col) {
                Ok(ty) if col.nullable || safe_default(col.default.as_deref()) => {
                    let qtable = qualified(target_driver, target_schema, target_name);
                    let mut definition =
                        format!("{} {}", data::quote_ident(target_driver, &col.name), ty);
                    if !col.nullable {
                        definition.push_str(" NOT NULL");
                    }
                    if let Some(default) = col.default.as_deref() {
                        if safe_default(Some(default)) {
                            definition.push_str(" DEFAULT ");
                            definition.push_str(default);
                        }
                    }
                    statements.push(format!("ALTER TABLE {} ADD COLUMN {}", qtable, definition));
                    changes.push(ColumnChange {
                        name: col.name.clone(),
                        source_type: Some(col.data_type.clone()),
                        target_type: Some(ty),
                        kind: "add_column".into(),
                        supported: true,
                        detail: None,
                    });
                }
                Ok(_) => {
                    unsupported.push(format!(
                        "missing target column {} is required and has no portable default",
                        col.name
                    ));
                    changes.push(ColumnChange {
                        name: col.name.clone(),
                        source_type: Some(col.data_type.clone()),
                        target_type: None,
                        kind: "missing_target_column".into(),
                        supported: false,
                        detail: Some("cannot add a required column without a safe default".into()),
                    });
                }
                Err(e) => unsupported.push(format!("column {}: {}", col.name, e)),
            },
            Some(target_col)
                if !same_type_family(&col.data_type, &target_col.data_type)
                    || col.is_identity != target_col.is_identity
                    || col.is_auto_increment != target_col.is_auto_increment =>
            {
                unsupported.push(format!(
                    "column {} type differs ({} → {})",
                    col.name, col.data_type, target_col.data_type
                ));
                changes.push(ColumnChange {
                    name: col.name.clone(),
                    source_type: Some(col.data_type.clone()),
                    target_type: Some(target_col.data_type.clone()),
                    kind: "type_mismatch".into(),
                    supported: false,
                    detail: Some("automatic type alteration is not applied".into()),
                });
            }
            Some(target_col) => {
                if effectively_nullable(col) != effectively_nullable(target_col) {
                    unsupported.push(format!("column {} nullability differs", col.name));
                    changes.push(ColumnChange {
                        name: col.name.clone(),
                        source_type: Some(if col.nullable { "NULL" } else { "NOT NULL" }.into()),
                        target_type: Some(
                            if target_col.nullable {
                                "NULL"
                            } else {
                                "NOT NULL"
                            }
                            .into(),
                        ),
                        kind: "nullability_difference".into(),
                        supported: false,
                        detail: Some("nullability changes are not applied automatically".into()),
                    });
                }
                if col.default != target_col.default
                    && !(is_generated_key(col) && is_generated_key(target_col))
                {
                    unsupported.push(format!("column {} default differs", col.name));
                    changes.push(ColumnChange {
                        name: col.name.clone(),
                        source_type: col.default.clone(),
                        target_type: target_col.default.clone(),
                        kind: "default_difference".into(),
                        supported: false,
                        detail: Some("default changes are not applied automatically".into()),
                    });
                }
                let expected = target_type(source_driver, target_driver, col)
                    .unwrap_or_else(|_| col.data_type.clone());
                if normalize_type(&expected) != normalize_type(&target_col.data_type) {
                    unsupported.push(format!(
                        "column {} has a structural type difference ({} maps to {}, target is {})",
                        col.name, col.data_type, expected, target_col.data_type
                    ));
                    changes.push(ColumnChange {
                        name: col.name.clone(),
                        source_type: Some(col.data_type.clone()),
                        target_type: Some(target_col.data_type.clone()),
                        kind: "type_shape_difference".into(),
                        supported: false,
                        detail: Some("automatic type alteration is not applied".into()),
                    });
                }
            }
        }
    }
    for col in &target.columns {
        if !source_cols.contains_key(col.name.as_str()) {
            changes.push(ColumnChange {
                name: col.name.clone(),
                source_type: None,
                target_type: Some(col.data_type.clone()),
                kind: "target_only_column".into(),
                supported: col.nullable || col.default.is_some() || col.is_auto_increment,
                detail: Some(
                    if col.nullable || col.default.is_some() || col.is_auto_increment {
                        "kept on target; inserts omit this column".into()
                    } else {
                        unsupported.push(format!(
                            "target-only required column {} prevents source inserts",
                            col.name
                        ));
                        "required target-only column has no default".into()
                    },
                ),
            });
        }
    }
    if source.primary_key != target.primary_key {
        unsupported.push("primary key definitions differ".into());
        changes.push(ColumnChange {
            name: "PRIMARY KEY".into(),
            source_type: Some(source.primary_key.join(", ")),
            target_type: Some(target.primary_key.join(", ")),
            kind: "primary_key_mismatch".into(),
            supported: false,
            detail: Some("automatic primary-key alteration is not applied".into()),
        });
    }
    if foreign_signature(source) != foreign_signature(target) {
        unsupported.push("foreign-key definitions differ and are not migrated".into());
        changes.push(ColumnChange {
            name: "FOREIGN KEYS".into(),
            source_type: Some(format!("{} definitions", source.foreign_keys.len())),
            target_type: Some(format!("{} definitions", target.foreign_keys.len())),
            kind: "foreign_key_mismatch".into(),
            supported: false,
            detail: Some("foreign keys are preserved on target; no automatic alteration".into()),
        });
    }
    if check_signature(source) != check_signature(target) {
        unsupported.push("check constraints differ and are not migrated".into());
        changes.push(ColumnChange {
            name: "CHECK CONSTRAINTS".into(),
            source_type: Some(format!("{} definitions", source.check_constraints.len())),
            target_type: Some(format!("{} definitions", target.check_constraints.len())),
            kind: "check_constraint_mismatch".into(),
            supported: false,
            detail: Some(
                "check constraints are preserved on target; no automatic alteration".into(),
            ),
        });
    }
    if index_signature(source) != index_signature(target) {
        unsupported.push("secondary indexes differ and are not migrated".into());
        changes.push(ColumnChange {
            name: "SECONDARY INDEXES".into(),
            source_type: Some(format!("{} definitions", index_signature(source).len())),
            target_type: Some(format!("{} definitions", index_signature(target).len())),
            kind: "index_mismatch".into(),
            supported: false,
            detail: Some("indexes are preserved on target; no automatic alteration".into()),
        });
    }
    if source.comment != target.comment
        || source.columns.iter().any(|sc| {
            target
                .columns
                .iter()
                .find(|tc| tc.name == sc.name)
                .is_some_and(|tc| sc.comment != tc.comment)
        })
    {
        unsupported.push("table or column comments differ and are not migrated".into());
        changes.push(ColumnChange {
            name: "COMMENTS".into(),
            source_type: Some("present or absent".into()),
            target_type: Some("present or absent".into()),
            kind: "comment_difference".into(),
            supported: false,
            detail: Some("comments are not changed automatically".into()),
        });
    }
    StructurePlan {
        source_table: source.name.clone(),
        target_table: target_name.into(),
        target_exists: true,
        changes,
        statements,
        supported: unsupported.is_empty(),
        reason: (!unsupported.is_empty()).then(|| unsupported.join("; ")),
        ddl_transactional: target_driver != DriverKind::Mysql,
    }
}

fn foreign_signature(desc: &TableDescription) -> Vec<String> {
    let mut items = desc
        .foreign_keys
        .iter()
        .map(|f| {
            format!(
                "{:?}|{}|{:?}|{:?}|{:?}|{:?}",
                f.columns,
                f.referenced_table,
                f.referenced_schema,
                f.referenced_columns,
                f.on_update,
                f.on_delete
            )
        })
        .collect::<Vec<_>>();
    items.sort();
    items
}

fn check_signature(desc: &TableDescription) -> Vec<String> {
    let mut items = desc
        .check_constraints
        .iter()
        .map(|c| c.definition.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    items.sort();
    items
}

fn index_signature(desc: &TableDescription) -> Vec<(Vec<String>, bool)> {
    let mut items = desc
        .indexes
        .iter()
        .filter(|i| !i.is_primary)
        .map(|i| (i.columns.clone(), i.is_unique))
        .collect::<Vec<_>>();
    items.sort();
    items
}

/// Source-table features the transfer does not reproduce. The first list
/// blocks the operation (the copy would be wrong); the second is reported as
/// "not copied" alongside the plan but does not affect the data itself.
async fn unmodeled_features(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<(Vec<String>, Vec<String>)> {
    let mut features = Vec::new();
    let mut notes = Vec::new();
    match pool {
        DbPool::Sqlite(p) => {
            let triggers: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name = ?",
            )
            .bind(table)
            .fetch_one(p)
            .await?;
            if triggers > 0 {
                notes.push("source table triggers are not copied".into());
            }
            let create: Option<String> =
                sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
                    .bind(table)
                    .fetch_optional(p)
                    .await?;
            let normalized = create.unwrap_or_default().to_ascii_lowercase();
            if normalized.contains(" generated ") || normalized.contains(" generated(") {
                features.push("generated columns are not copied".into());
            }
            if normalized.starts_with("create virtual table") {
                features.push("SQLite virtual tables are not copied".into());
            }
            if normalized.contains(" without rowid") || normalized.ends_with(" strict") {
                features.push("WITHOUT ROWID / STRICT table options are not copied".into());
            }
        }
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or("public");
            let triggers: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM information_schema.triggers \
                 WHERE event_object_schema = $1 AND event_object_table = $2",
            )
            .bind(schema)
            .bind(table)
            .fetch_one(p)
            .await?;
            if triggers > 0 {
                notes.push("source table triggers are not copied".into());
            }
            let generated: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM information_schema.columns \
                 WHERE table_schema = $1 AND table_name = $2 AND is_generated <> 'NEVER'",
            )
            .bind(schema)
            .bind(table)
            .fetch_one(p)
            .await?;
            if generated > 0 {
                features.push("generated columns are not copied".into());
            }
            let partitioned: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.relname = $1 AND n.nspname = $2 AND c.relkind = 'p'",
            )
            .bind(table)
            .bind(schema)
            .fetch_one(p)
            .await?;
            if partitioned > 0 {
                features.push("partitioned tables are not copied".into());
            }
        }
        DbPool::Mysql(p) => {
            let schema = schema.unwrap_or("");
            let triggers: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM information_schema.triggers \
                 WHERE trigger_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND event_object_table = ?",
            )
            .bind(schema)
            .bind(table)
            .fetch_one(p)
            .await?;
            if triggers > 0 {
                notes.push("source table triggers are not copied".into());
            }
            let generated: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM information_schema.columns \
                 WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
                   AND table_name = ? AND generation_expression <> ''",
            )
            .bind(schema)
            .bind(table)
            .fetch_one(p)
            .await?;
            if generated > 0 {
                features.push("generated columns are not copied".into());
            }
            let partitions: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM information_schema.partitions \
                 WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
                   AND table_name = ? AND partition_name IS NOT NULL",
            )
            .bind(schema)
            .bind(table)
            .fetch_one(p)
            .await?;
            if partitions > 0 {
                features.push("partitioned tables are not copied".into());
            }
            let timestamps: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM information_schema.columns \
                 WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
                   AND table_name = ? AND data_type = 'timestamp'",
            )
            .bind(schema)
            .bind(table)
            .fetch_one(p)
            .await?;
            if timestamps > 0 {
                features.push(
                    "MySQL TIMESTAMP session-time-zone normalization is not guaranteed".into(),
                );
            }
        }
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Structure synchronization"),
    }
    Ok((features, notes))
}

async fn mysql_table_is_transactional(
    pool: &sqlx::MySqlPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<bool> {
    let engine: Option<String> = sqlx::query_scalar(
        "SELECT CAST(engine AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci FROM information_schema.tables \
         WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ?",
    )
    .bind(schema.unwrap_or(""))
    .bind(table)
    .fetch_optional(pool)
    .await?;
    Ok(engine
        .as_deref()
        .is_some_and(|e| e.eq_ignore_ascii_case("InnoDB")))
}

fn same_type_family(a: &str, b: &str) -> bool {
    type_family(a)
        .zip(type_family(b))
        .is_some_and(|(fa, fb)| fa == fb)
}

fn normalize_type(s: &str) -> String {
    let normalized: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '"' && *c != '`')
        .flat_map(char::to_lowercase)
        .collect();
    // PostgreSQL serial types are creation-time shorthands: the catalog
    // reports the underlying integer type plus a sequence default.
    match normalized.as_str() {
        "serial" | "serial4" => "integer".into(),
        "bigserial" | "serial8" => "bigint".into(),
        "smallserial" | "serial2" => "smallint".into(),
        _ => normalized,
    }
}

/// Primary-key columns cannot hold NULL in practice; SQLite reports its
/// `INTEGER PRIMARY KEY` rowid alias as nullable.
fn effectively_nullable(col: &design::ColumnDetail) -> bool {
    col.nullable && !col.is_primary_key
}

/// Server-generated keys (AUTO_INCREMENT, identity, serial `nextval`), whose
/// catalog defaults differ by engine without differing in behavior.
fn is_generated_key(col: &design::ColumnDetail) -> bool {
    col.is_auto_increment
        || col.is_identity
        || col
            .default
            .as_deref()
            .is_some_and(|d| d.trim_start().to_ascii_lowercase().starts_with("nextval("))
}

fn column_data_compatible(source: &design::ColumnDetail, target: &design::ColumnDetail) -> bool {
    let source_family = type_family(&source.data_type);
    let target_family = type_family(&target.data_type);
    if source_family != target_family {
        if source_family == Some("integer") && target_family == Some("decimal") {
            let integer_digits = integer_decimal_digits(&source.data_type);
            return match (
                integer_digits,
                target.numeric_precision,
                target.numeric_scale,
            ) {
                (Some(src), Some(precision), Some(scale)) => precision - scale >= src,
                (Some(_), None, _) => true,
                _ => false,
            };
        }
        return false;
    }
    let family = source_family;
    match family {
        Some("text") => match (source.char_max_length, target.char_max_length) {
            (Some(src), Some(dst)) => dst >= src,
            (None, Some(_)) => false,
            _ => true,
        },
        Some("decimal") => match (
            source.numeric_precision,
            source.numeric_scale,
            target.numeric_precision,
            target.numeric_scale,
        ) {
            (Some(sp), Some(ss), Some(tp), Some(ts)) => tp - ts >= sp - ss && ts >= ss,
            (Some(_), _, None, _) => true,
            (None, _, Some(_), _) => false,
            _ => true,
        },
        Some("integer") => integer_fits(&source.data_type, &target.data_type),
        Some("datetime") => datetime_kind(&source.data_type) == datetime_kind(&target.data_type),
        _ => true,
    }
}

fn integer_fits(source: &str, target: &str) -> bool {
    let (Some((src_width, src_unsigned)), Some((dst_width, dst_unsigned))) =
        (integer_capacity(source), integer_capacity(target))
    else {
        return false;
    };
    if src_unsigned {
        if dst_unsigned {
            src_width <= dst_width
        } else {
            src_width < dst_width
        }
    } else {
        !dst_unsigned && src_width <= dst_width
    }
}

fn integer_decimal_digits(ty: &str) -> Option<i64> {
    if ty.trim() == "INTEGER" {
        // SQLite's INTEGER affinity stores signed 64-bit values.
        return Some(19);
    }
    let (width, unsigned) = integer_capacity(ty)?;
    Some(match (width, unsigned) {
        (1, false) => 3,
        (1, true) => 3,
        (2, false) => 5,
        (2, true) => 5,
        (3, false) => 8,
        (3, true) => 8,
        (4, false) => 10,
        (4, true) => 10,
        (8, false) => 19,
        (8, true) => 20,
        _ => return None,
    })
}

fn has_mysql_timestamp(desc: &TableDescription) -> bool {
    desc.columns
        .iter()
        .any(|c| c.data_type.eq_ignore_ascii_case("timestamp"))
}

fn has_timezone_timestamp(desc: &TableDescription) -> bool {
    desc.columns
        .iter()
        .any(|c| datetime_kind(&c.data_type) == "timestamp_tz")
}

fn type_family(ty: &str) -> Option<&'static str> {
    let t = ty.to_ascii_lowercase();
    if t.ends_with("[]") {
        None
    } else if integer_base(&t).is_some() {
        Some("integer")
    } else if t.contains("char") || t.contains("text") || t == "citext" {
        Some("text")
    } else if t.contains("decimal") || t.contains("numeric") || t == "money" {
        Some("decimal")
    } else if t.contains("real") || t.contains("double") || t.contains("float") {
        Some("float")
    } else if t.contains("bool") || t == "bit(1)" {
        Some("bool")
    } else if t == "date"
        || t == "time"
        || t.starts_with("timestamp")
        || t == "timestamptz"
        || t == "datetime"
        || t == "year"
    {
        Some("datetime")
    } else if t.contains("blob") || t.contains("binary") || t == "bytea" {
        Some("binary")
    } else if t.contains("json") {
        Some("json")
    } else {
        None
    }
}

fn integer_base(ty: &str) -> Option<&str> {
    let token = ty.split_whitespace().next()?.split('(').next()?.trim();
    matches!(
        token,
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "int2"
            | "int4"
            | "int8"
            | "serial"
            | "bigserial"
    )
    .then_some(token)
}

fn integer_capacity(ty: &str) -> Option<(u8, bool)> {
    let t = ty.to_ascii_lowercase();
    let base = integer_base(&t)?;
    let width = if base == "tinyint" {
        1
    } else if base == "smallint" || base == "int2" {
        2
    } else if base == "mediumint" {
        3
    } else if base == "bigint" || base == "int8" || base == "bigserial" {
        8
    } else {
        4
    };
    Some((width, t.contains("unsigned")))
}

fn datetime_kind(ty: &str) -> &'static str {
    let t = ty.to_ascii_lowercase();
    if t == "date" {
        "date"
    } else if t == "time" || t.starts_with("time without") {
        "time"
    } else if t.contains("with time zone") || t == "timestamptz" || t == "timestamp" {
        "timestamp_tz"
    } else {
        "timestamp_local"
    }
}

fn target_type(
    _source_driver: DriverKind,
    target_driver: DriverKind,
    col: &design::ColumnDetail,
) -> AppResult<String> {
    if target_driver == DriverKind::Sqlite && col.is_auto_increment && !col.is_primary_key {
        return Err(AppError::msg(
            "SQLite cannot preserve a non-primary auto-increment column",
        ));
    }
    let src = col.data_type.to_ascii_lowercase();
    if src.ends_with("[]") {
        return Err(AppError::msg("array columns are not copied automatically"));
    }
    let family = if integer_base(&src).is_some() {
        "integer"
    } else if src.contains("char") || src.contains("text") {
        "text"
    } else if src.contains("decimal") || src.contains("numeric") || src == "money" {
        "decimal"
    } else if src.contains("real") || src.contains("double") || src.contains("float") {
        "float"
    } else if src.contains("bool") {
        "bool"
    } else if src.contains("date") || src.contains("time") || src == "year" {
        "datetime"
    } else if src.contains("blob") || src.contains("binary") || src == "bytea" {
        "binary"
    } else if src.contains("json") {
        "json"
    } else {
        return Err(AppError::msg(format!(
            "unsupported source type {}",
            col.data_type
        )));
    };
    if family == "integer" && src.contains("unsigned") {
        let ty = match target_driver {
            DriverKind::Mysql => {
                let base = src.split_whitespace().next().unwrap_or("BIGINT");
                format!("{} UNSIGNED", base.to_ascii_uppercase())
            }
            DriverKind::Postgres if src.contains("bigint") || src.contains("int8") => {
                "NUMERIC(20,0)".into()
            }
            DriverKind::Postgres => match src.as_str() {
                "tinyint unsigned" => "SMALLINT".into(),
                "smallint unsigned" => "INTEGER".into(),
                _ => "BIGINT".into(),
            },
            DriverKind::Sqlite if src.contains("bigint") => "TEXT".into(),
            DriverKind::Sqlite => "INTEGER".into(),
            DriverKind::Redis => return Err(AppError::msg("Redis target is unsupported")),
        };
        return Ok(ty);
    }
    let ty = match (target_driver, family) {
        (_, "integer") if col.is_auto_increment && col.is_primary_key => match target_driver {
            DriverKind::Sqlite => "INTEGER",
            DriverKind::Postgres if col.is_identity => "BIGINT",
            DriverKind::Postgres => "BIGSERIAL",
            DriverKind::Mysql => "BIGINT",
            DriverKind::Redis => return Err(AppError::msg("Redis target is unsupported")),
        },
        (DriverKind::Sqlite, "integer") => "INTEGER",
        (DriverKind::Postgres, "integer") => "BIGINT",
        (DriverKind::Mysql, "integer") => "BIGINT",
        (DriverKind::Sqlite, "text") => "TEXT",
        (DriverKind::Postgres, "text") => "TEXT",
        (DriverKind::Mysql, "text") => "LONGTEXT",
        (DriverKind::Sqlite, "decimal") => "NUMERIC",
        (DriverKind::Postgres, "decimal") => "NUMERIC",
        (DriverKind::Mysql, "decimal") => "DECIMAL",
        (DriverKind::Sqlite, "float") => "REAL",
        (DriverKind::Postgres, "float") => "DOUBLE PRECISION",
        (DriverKind::Mysql, "float") => "DOUBLE",
        (DriverKind::Sqlite, "bool") => "INTEGER",
        (DriverKind::Postgres, "bool") => "BOOLEAN",
        (DriverKind::Mysql, "bool") => "BOOLEAN",
        (DriverKind::Sqlite, "datetime") => "TEXT",
        (DriverKind::Postgres, "datetime") => "TIMESTAMP",
        (DriverKind::Mysql, "datetime") => "DATETIME",
        (DriverKind::Sqlite, "binary") => "BLOB",
        (DriverKind::Postgres, "binary") => "BYTEA",
        (DriverKind::Mysql, "binary") => "LONGBLOB",
        (DriverKind::Sqlite, "json") => "TEXT",
        (DriverKind::Postgres, "json") => "JSONB",
        (DriverKind::Mysql, "json") => "JSON",
        (_, other) => return Err(AppError::msg(format!("unsupported type family {other}"))),
    };
    let mut ty = ty.to_string();
    if col.is_identity && !(target_driver == DriverKind::Postgres && col.is_primary_key) {
        return Err(AppError::msg(
            "identity columns only map to PostgreSQL identity columns",
        ));
    }
    if family == "decimal" {
        if let Some(precision) = col.numeric_precision {
            ty = match col.numeric_scale {
                Some(scale) => format!("{}({},{})", ty, precision, scale),
                None => format!("{}({})", ty, precision),
            };
        }
    } else if family == "text" && col.char_max_length.is_some() {
        let len = col.char_max_length.unwrap_or_default();
        let source_name = col.data_type.to_ascii_lowercase();
        let base = if source_name.contains("char") && !source_name.contains("varying") {
            "CHAR"
        } else {
            "VARCHAR"
        };
        ty = match target_driver {
            DriverKind::Mysql => format!("{}({})", base, len),
            DriverKind::Postgres => format!("{}({})", base, len),
            DriverKind::Sqlite => format!("{}({})", base, len),
            DriverKind::Redis => return Err(AppError::msg("Redis target is unsupported")),
        };
    } else if family == "datetime" {
        ty = match (target_driver, datetime_kind(&col.data_type)) {
            (DriverKind::Sqlite, _) => "TEXT".into(),
            (DriverKind::Postgres, "date") => "DATE".into(),
            (DriverKind::Postgres, "time") => "TIME".into(),
            (DriverKind::Postgres, "timestamp_tz") => "TIMESTAMPTZ".into(),
            (DriverKind::Postgres, _) => "TIMESTAMP".into(),
            (DriverKind::Mysql, "date") => "DATE".into(),
            (DriverKind::Mysql, "time") => "TIME".into(),
            (DriverKind::Mysql, "timestamp_tz") => "TIMESTAMP".into(),
            (DriverKind::Mysql, _) => "DATETIME".into(),
            (DriverKind::Redis, _) => return Err(AppError::msg("Redis target is unsupported")),
        };
    }
    Ok(ty)
}

/// `CREATE INDEX` for a copied secondary index, or why it is skipped. Names
/// are regenerated from the target table so they cannot collide with the
/// source's (index names are schema-wide on PostgreSQL).
fn index_create_sql(
    source: &TableDescription,
    index: &design::IndexInfo,
    source_driver: DriverKind,
    target_driver: DriverKind,
    target_schema: Option<&str>,
    target_name: &str,
) -> Result<String, String> {
    if index.columns.is_empty() {
        return Err("expression or functional index is not copied".into());
    }
    let mut using = String::new();
    if let Some(method) = index.method.as_deref().filter(|m| !m.eq_ignore_ascii_case("btree")) {
        if source_driver == DriverKind::Postgres && target_driver == DriverKind::Postgres {
            using = format!(" USING {}", method.to_ascii_lowercase());
        } else if !method.eq_ignore_ascii_case("hash") {
            return Err(format!("{method} indexes are not portable"));
        }
    }
    let mut parts = Vec::new();
    for name in &index.columns {
        let Some(col) = source.columns.iter().find(|c| &c.name == name) else {
            return Err("expression or functional index is not copied".into());
        };
        let mut part = data::quote_ident(target_driver, name);
        if target_driver == DriverKind::Mysql {
            let ty = target_type(source_driver, target_driver, col).map_err(|e| e.to_string())?;
            let lower = ty.to_ascii_lowercase();
            if lower.starts_with("json") {
                return Err("JSON columns cannot be indexed directly on MySQL".into());
            }
            if lower.contains("text") || lower.contains("blob") {
                // A prefix changes what UNIQUE means, so only plain indexes
                // get one.
                if index.is_unique {
                    return Err("a UNIQUE index on a TEXT/BLOB column needs a prefix length on MySQL".into());
                }
                part.push_str("(255)");
            }
        }
        parts.push(part);
    }
    let suffix = if index.is_unique { "key" } else { "idx" };
    let generated: String = format!("{}_{}_{}", target_name, index.columns.join("_"), suffix)
        .chars()
        .take(60)
        .collect();
    Ok(format!(
        "CREATE {}INDEX {} ON {}{} ({})",
        if index.is_unique { "UNIQUE " } else { "" },
        data::quote_ident(target_driver, &generated),
        qualified(target_driver, target_schema, target_name),
        using,
        parts.join(", ")
    ))
}

fn create_table_sql(
    source: &TableDescription,
    source_driver: DriverKind,
    target_driver: DriverKind,
    target_schema: Option<&str>,
    target_name: &str,
) -> AppResult<String> {
    let mut definitions = Vec::new();
    let mut primary = Vec::new();
    for col in &source.columns {
        let ty = target_type(source_driver, target_driver, col)?;
        let mut d = format!("{} {}", data::quote_ident(target_driver, &col.name), ty);
        if !col.nullable {
            d.push_str(" NOT NULL");
        }
        if let Some(default) = col
            .default
            .as_deref()
            .filter(|_| !col.is_auto_increment && !col.is_identity)
        {
            if !safe_default(Some(default)) {
                return Err(AppError::msg(format!(
                    "column {} has a non-portable default expression",
                    col.name
                )));
            }
            d.push_str(" DEFAULT ");
            d.push_str(default);
        }
        if col.is_auto_increment && target_driver == DriverKind::Mysql {
            d.push_str(" AUTO_INCREMENT");
        }
        if col.is_identity && target_driver == DriverKind::Postgres {
            d.push_str(if col.identity_generation.as_deref() == Some("ALWAYS") {
                " GENERATED ALWAYS AS IDENTITY"
            } else {
                " GENERATED BY DEFAULT AS IDENTITY"
            });
        }
        let inline_sqlite_auto = col.is_auto_increment
            && target_driver == DriverKind::Sqlite
            && ty == "INTEGER"
            && col.is_primary_key;
        if inline_sqlite_auto {
            d.push_str(" PRIMARY KEY AUTOINCREMENT");
        }
        definitions.push(d);
        if col.is_primary_key && !inline_sqlite_auto {
            primary.push(data::quote_ident(target_driver, &col.name));
        }
    }
    if !primary.is_empty() {
        definitions.push(format!("PRIMARY KEY ({})", primary.join(", ")));
    }
    let name = qualified(target_driver, target_schema, target_name);
    let engine_clause = if target_driver == DriverKind::Mysql {
        " ENGINE=InnoDB"
    } else {
        ""
    };
    Ok(format!(
        "CREATE TABLE {} ({}){}",
        name,
        definitions.join(", "),
        engine_clause
    ))
}

fn safe_default(default: Option<&str>) -> bool {
    let Some(s) = default.map(str::trim) else {
        return true;
    };
    let lower = s.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "null" | "true" | "false" | "current_timestamp"
    ) {
        return true;
    }
    if s.parse::<f64>().is_ok() {
        return true;
    }
    is_quoted_literal(s)
}

fn is_quoted_literal(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'\'' || *bytes.last().unwrap_or(&0) != b'\'' {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() - 1 {
        if bytes[i] == b'\'' {
            if i + 1 < bytes.len() - 1 && bytes[i + 1] == b'\'' {
                i += 2;
                continue;
            }
            return false;
        }
        i += 1;
    }
    true
}

fn qualified(driver: DriverKind, schema: Option<&str>, table: &str) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(schema) => format!(
            "{}.{}",
            data::quote_ident(driver, schema),
            data::quote_ident(driver, table)
        ),
        None if driver == DriverKind::Postgres => format!(
            "{}.{}",
            data::quote_ident(driver, "public"),
            data::quote_ident(driver, table)
        ),
        None => data::quote_ident(driver, table),
    }
}

async fn read_rows(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
    description: &TableDescription,
    columns: &[String],
) -> AppResult<BTreeMap<String, Vec<Json>>> {
    if description.primary_key.is_empty() {
        return Err(AppError::msg("data synchronization requires a primary key"));
    }
    let indexes: Vec<usize> = description
        .primary_key
        .iter()
        .map(|pk| {
            columns
                .iter()
                .position(|c| c == pk)
                .ok_or_else(|| AppError::msg(format!("primary key column {} is unavailable", pk)))
        })
        .collect::<AppResult<_>>()?;
    let driver = pool.driver();
    let select = columns
        .iter()
        .map(|name| {
            let quoted = data::quote_ident(driver, name);
            if description
                .columns
                .iter()
                .find(|column| column.name == *name)
                .is_some_and(|column| type_family(&column.data_type) == Some("decimal"))
            {
                let ty = if driver == DriverKind::Mysql {
                    "CHAR"
                } else {
                    "TEXT"
                };
                format!("CAST({quoted} AS {ty}) AS {quoted}")
            } else {
                quoted
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let order = description
        .primary_key
        .iter()
        .map(|c| data::quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let target = qualified(driver, schema, table);
    let mut snapshot = SnapshotConnection::begin(pool).await?;
    let result = read_rows_pages(&mut snapshot, table, &target, &select, &order, &indexes).await;
    snapshot.finish().await?;
    result
}

async fn read_rows_pages<'a>(
    snapshot: &'a mut SnapshotConnection,
    table: &'a str,
    target: &'a str,
    select: &'a str,
    order: &'a str,
    indexes: &'a [usize],
) -> AppResult<BTreeMap<String, Vec<Json>>> {
    let mut result = BTreeMap::new();
    let mut offset = 0usize;
    let mut bytes = 0usize;
    loop {
        let sql = format!(
            "SELECT {} FROM {} ORDER BY {} LIMIT {} OFFSET {}",
            select, target, order, PAGE_SIZE, offset
        );
        let page = snapshot.fetch_rows(&sql).await?;
        if page.is_empty() {
            break;
        }
        for row in page {
            if result.len() >= MAX_SYNC_ROWS {
                return Err(AppError::msg(format!(
                    "table {} exceeds the {} row synchronization preview limit",
                    table, MAX_SYNC_ROWS
                )));
            }
            bytes = bytes.saturating_add(serde_json::to_vec(&row)?.len());
            if bytes > MAX_SYNC_BYTES {
                return Err(AppError::msg(format!(
                    "table {} exceeds the {} MiB synchronization preview budget",
                    table,
                    MAX_SYNC_BYTES / 1024 / 1024
                )));
            }
            let key = serde_json::to_string(
                &indexes
                    .iter()
                    .map(|idx| row.get(*idx).cloned().unwrap_or(Json::Null))
                    .collect::<Vec<_>>(),
            )?;
            if result.insert(key, row).is_some() {
                return Err(AppError::msg("source or target primary key is not unique"));
            }
        }
        offset += PAGE_SIZE;
        if offset > MAX_SYNC_ROWS && result.len() > MAX_SYNC_ROWS {
            return Err(AppError::msg("synchronization row limit exceeded"));
        }
        if offset >= MAX_SYNC_ROWS + PAGE_SIZE {
            // One final empty page is needed to distinguish exactly-at-cap from
            // over-cap, but no unbounded OFFSET scan is allowed.
            let sql = format!(
                "SELECT {} FROM {} ORDER BY {} LIMIT 1 OFFSET {}",
                select, target, order, offset
            );
            let extra = snapshot.fetch_rows(&sql).await?;
            if !extra.is_empty() {
                return Err(AppError::msg("synchronization row limit exceeded"));
            }
            break;
        }
    }
    Ok(result)
}

enum SnapshotConnection {
    Sqlite(exec::GuardedConnection<sqlx::Sqlite>),
    Postgres(exec::GuardedConnection<sqlx::Postgres>),
    Mysql(exec::GuardedConnection<sqlx::MySql>),
}

impl SnapshotConnection {
    async fn begin(pool: &DbPool) -> AppResult<Self> {
        match pool {
            DbPool::Sqlite(pool) => {
                let mut conn = exec::GuardedConnection::new(pool.acquire().await?);
                sqlx::query("PRAGMA query_only = ON")
                    .execute(&mut *conn.inner)
                    .await?;
                sqlx::Executor::execute(&mut *conn.inner, "BEGIN DEFERRED").await?;
                Ok(Self::Sqlite(conn))
            }
            DbPool::Postgres(pool) => {
                let mut conn = exec::GuardedConnection::new(pool.acquire().await?);
                sqlx::Executor::execute(
                    &mut *conn.inner,
                    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
                )
                .await?;
                Ok(Self::Postgres(conn))
            }
            DbPool::Mysql(pool) => {
                let mut conn = exec::GuardedConnection::new(pool.acquire().await?);
                sqlx::Executor::execute(
                    &mut *conn.inner,
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
                )
                .await?;
                sqlx::Executor::execute(
                    &mut *conn.inner,
                    "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
                )
                .await?;
                Ok(Self::Mysql(conn))
            }
            DbPool::Redis(_) => Err(AppError::msg(
                "Redis is not supported for relational synchronization",
            )),
        }
    }

    async fn fetch_rows<'a>(&'a mut self, sql: &'a str) -> AppResult<Vec<Vec<Json>>> {
        let started = Instant::now();
        match self {
            Self::Sqlite(conn) => {
                let rows = sqlx::query(sql).fetch_all(&mut *conn.inner).await?;
                Ok(exec::decode_sqlite(rows, started).rows)
            }
            Self::Postgres(conn) => {
                let rows = sqlx::query(sql).fetch_all(&mut *conn.inner).await?;
                Ok(exec::decode_postgres(rows, started).rows)
            }
            Self::Mysql(conn) => {
                let rows = sqlx::query(sql).fetch_all(&mut *conn.inner).await?;
                Ok(exec::decode_mysql(rows, started).rows)
            }
        }
    }

    async fn finish(self) -> AppResult<()> {
        match self {
            Self::Sqlite(mut conn) => {
                sqlx::Executor::execute(&mut *conn.inner, "ROLLBACK").await?;
                sqlx::query("PRAGMA query_only = OFF")
                    .execute(&mut *conn.inner)
                    .await?;
                conn.mark_reusable();
            }
            Self::Postgres(mut conn) => {
                sqlx::Executor::execute(&mut *conn.inner, "ROLLBACK").await?;
                conn.mark_reusable();
            }
            Self::Mysql(mut conn) => {
                sqlx::Executor::execute(&mut *conn.inner, "ROLLBACK").await?;
                conn.mark_reusable();
            }
        }
        Ok(())
    }
}

fn rows_exceed_binary_limit(
    description: &TableDescription,
    columns: &[String],
    rows: &BTreeMap<String, Vec<Json>>,
) -> bool {
    let encoded_limit = MAX_SYNC_BINARY_BYTES.div_ceil(3) * 4;
    columns.iter().enumerate().any(|(idx, name)| {
        description
            .columns
            .iter()
            .find(|column| column.name == *name)
            .is_some_and(|column| is_binary_type(&column.data_type))
            && rows.values().any(|row| {
                row.get(idx)
                    .and_then(Json::as_str)
                    .is_some_and(|encoded| encoded.len() > encoded_limit)
            })
    })
}

struct Rows(QueryResult);
fn decode_page(_pool: &DbPool, rows: Rows, _started: Instant) -> AppResult<Vec<Vec<Json>>> {
    Ok(rows.0.rows)
}

fn estimate_bytes(rows: &BTreeMap<String, Vec<Json>>) -> AppResult<usize> {
    rows.values().try_fold(0usize, |total, row| {
        serde_json::to_vec(row)
            .map(|bytes| total.saturating_add(bytes.len()))
            .map_err(AppError::from)
    })
}

fn sample_key(key: &str) -> String {
    const MAX_SAMPLE_KEY_BYTES: usize = 256;
    if key.len() <= MAX_SAMPLE_KEY_BYTES {
        return key.to_string();
    }
    let mut end = MAX_SAMPLE_KEY_BYTES;
    while !key.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &key[..end])
}

pub async fn search(pool: &DbPool, request: &SearchRequest) -> AppResult<SearchResult> {
    if request.text.is_empty() {
        return Err(AppError::msg("search text is required"));
    }
    if request.text.len() > 4096 || request.tables.iter().any(|table| table.len() > 256) {
        return Err(AppError::msg(
            "search text or table name exceeds the supported length",
        ));
    }
    if pool.driver() == DriverKind::Redis {
        return crate::db::redis_ops::unsupported("Global data search");
    }
    let schema = if pool.driver() == DriverKind::Postgres
        && request
            .schema
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        Some("public")
    } else {
        request.schema.as_deref()
    };
    if request.tables.len() > MAX_SEARCH_TABLES {
        return Err(AppError::msg(format!(
            "global search is limited to {} tables; choose a narrower table set",
            MAX_SEARCH_TABLES
        )));
    }
    let selected: Vec<String> = if request.tables.is_empty() {
        list_table_names(pool, schema, MAX_SEARCH_TABLES + 1).await?
    } else {
        request.tables.clone()
    };
    if selected.len() > MAX_SEARCH_TABLES {
        return Err(AppError::msg(format!(
            "global search is limited to {} tables; choose a narrower schema or table set",
            MAX_SEARCH_TABLES
        )));
    }
    let mut hits = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    let mut tables_searched = 0usize;
    for table in &selected {
        tables_searched += 1;
        let desc = match design::describe(pool, schema, table).await {
            Ok(d) => d,
            Err(_) => continue,
        };
        let pk_names = &desc.primary_key;
        for col in &desc.columns {
            if is_binary_type(&col.data_type) {
                continue;
            }
            let driver = pool.driver();
            let target = qualified(driver, schema, table);
            let qcol = data::quote_ident(driver, &col.name);
            let cast = match driver {
                DriverKind::Mysql => format!("CAST({} AS CHAR)", qcol),
                _ => format!("CAST({} AS TEXT)", qcol),
            };
            let excerpt = format!("SUBSTR({}, 1, 512)", cast);
            let predicate = match (driver, request.case_sensitive) {
                (DriverKind::Postgres, true) => format!("{} LIKE $1 ESCAPE '!'", cast),
                (DriverKind::Postgres, false) => format!("{} ILIKE $1 ESCAPE '!'", cast),
                (DriverKind::Mysql, true) => format!("BINARY {} LIKE ? ESCAPE '!'", cast),
                (DriverKind::Mysql, false) => format!("{} LIKE ? ESCAPE '!'", cast),
                (DriverKind::Sqlite, true) => format!("INSTR({}, ?) > 0", cast),
                (DriverKind::Sqlite, false) => format!("{} LIKE ? ESCAPE '!'", cast),
                (DriverKind::Redis, _) => unreachable!("Redis search is rejected above"),
            };
            let pk_select = pk_names
                .iter()
                .map(|name| data::quote_ident(driver, name))
                .collect::<Vec<_>>()
                .join(", ");
            let selected_values = if pk_select.is_empty() {
                excerpt
            } else {
                format!("{}, {}", pk_select, excerpt)
            };
            let sql = format!(
                "SELECT {} FROM {} WHERE {} LIMIT {}",
                selected_values,
                target,
                predicate,
                MAX_SEARCH_HITS + 1
            );
            let pattern = match (driver, request.case_sensitive) {
                (DriverKind::Sqlite, true) => request.text.clone(),
                _ => format!("%{}%", escape_like(&request.text)),
            };
            let started = Instant::now();
            let rows = query_search_rows(pool, &sql, &pattern).await?;
            let page = decode_page(pool, rows, started)?;
            for row in page {
                if hits.len() >= request.limit.unwrap_or(100).clamp(1, MAX_SEARCH_HITS)
                    || hits.len() >= MAX_SEARCH_HITS
                {
                    truncated = true;
                    break;
                }
                let pk_values = pk_names
                    .iter()
                    .enumerate()
                    .filter_map(|(i, name)| row.get(i).cloned().map(|v| (name.clone(), v)))
                    .collect::<Vec<_>>();
                let value = row.get(pk_names.len()).cloned().unwrap_or(Json::Null);
                let hit = SearchHit {
                    schema: schema.map(str::to_owned),
                    table: table.clone(),
                    column: col.name.clone(),
                    primary_key: pk_values,
                    value,
                };
                bytes = bytes.saturating_add(serde_json::to_vec(&hit)?.len());
                if bytes > MAX_SEARCH_BYTES {
                    truncated = true;
                    break;
                }
                hits.push(hit);
            }
            if truncated {
                break;
            }
        }
        if truncated {
            break;
        }
    }
    Ok(SearchResult {
        hits,
        tables_searched,
        truncated,
        bytes,
    })
}

fn is_binary_type(ty: &str) -> bool {
    let t = ty.to_ascii_lowercase();
    t.contains("blob") || t.contains("binary") || t == "bytea"
}

fn edit_bind_value(target: &TableDescription, column: &str, value: &Json) -> AppResult<Json> {
    if !is_binary_type(
        target
            .columns
            .iter()
            .find(|col| col.name == column)
            .map(|col| col.data_type.as_str())
            .unwrap_or_default(),
    ) || value.is_null()
    {
        return Ok(value.clone());
    }
    let encoded = value.as_str().ok_or_else(|| {
        AppError::msg(format!(
            "binary column {} did not decode to base64 text",
            column
        ))
    })?;
    Ok(serde_json::json!({ "$binary": encoded }))
}

fn escape_like(text: &str) -> String {
    text.replace('!', "!!")
        .replace('%', "!%")
        .replace('_', "!_")
}

async fn query_search_rows(pool: &DbPool, sql: &str, pattern: &str) -> AppResult<Rows> {
    Ok(Rows(
        exec::execute_readonly_text_bind(pool, sql, pattern).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sqlite_snapshot_keeps_offset_pages_stable_during_concurrent_delete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paging.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t(id INTEGER PRIMARY KEY)").execute(&pool).await.unwrap();
        for id in 1..=65 {
            sqlx::query("INSERT INTO t VALUES (?)").bind(id).execute(&pool).await.unwrap();
        }
        let wrapped = DbPool::Sqlite(pool.clone());
        let mut snapshot = SnapshotConnection::begin(&wrapped).await.unwrap();
        let first = snapshot.fetch_rows("SELECT id FROM t ORDER BY id LIMIT 32 OFFSET 0").await.unwrap();
        assert_eq!(first.last().unwrap()[0].as_i64(), Some(32));
        let mut writer = pool.acquire().await.unwrap();
        sqlx::query("DELETE FROM t WHERE id=1").execute(&mut *writer).await.unwrap();
        let second = snapshot.fetch_rows("SELECT id FROM t ORDER BY id LIMIT 32 OFFSET 32").await.unwrap();
        assert_eq!(second.first().unwrap()[0].as_i64(), Some(33));
        assert!(first.iter().chain(&second).any(|row| row[0].as_i64() == Some(33)));
        snapshot.finish().await.unwrap();
        sqlx::query("INSERT INTO t VALUES (100)").execute(&pool).await.unwrap();
        drop(writer);
        pool.close().await;
    }

    #[tokio::test]
    async fn sqlite_snapshot_rolls_back_and_resets_query_only_after_read_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paging-error.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t(id INTEGER PRIMARY KEY)").execute(&pool).await.unwrap();
        let wrapped = DbPool::Sqlite(pool.clone());
        let mut snapshot = SnapshotConnection::begin(&wrapped).await.unwrap();
        assert!(snapshot.fetch_rows("SELECT missing FROM t").await.is_err());
        snapshot.finish().await.unwrap();
        sqlx::query("INSERT INTO t VALUES (1)").execute(&pool).await.unwrap();
        pool.close().await;
    }

    async fn live_snapshot_concurrent_delete(pool: DbPool, driver: DriverKind) -> AppResult<()> {
        let table = format!("rdb_snapshot_{}", uuid::Uuid::new_v4().simple());
        let target = data::quote_ident(driver, &table);
        let create = match driver {
            DriverKind::Postgres => format!("CREATE TABLE {target} (id BIGINT PRIMARY KEY)"),
            DriverKind::Mysql => format!("CREATE TABLE {target} (id BIGINT PRIMARY KEY) ENGINE=InnoDB"),
            _ => unreachable!(),
        };
        execute_snapshot_test_sql(&pool, &create).await?;
        let insert = format!(
            "INSERT INTO {target} (id) VALUES {}",
            (1..=65).map(|id| format!("({id})")).collect::<Vec<_>>().join(",")
        );
        let read_result: AppResult<(i64, i64)> = async {
            execute_snapshot_test_sql(&pool, &insert).await?;
            let mut snapshot = SnapshotConnection::begin(&pool).await?;
            let first_sql = format!("SELECT id FROM {target} ORDER BY id LIMIT 32 OFFSET 0");
            let first = snapshot.fetch_rows(&first_sql).await?;
            let second_sql = format!("SELECT id FROM {target} ORDER BY id LIMIT 32 OFFSET 32");
            match &pool {
                DbPool::Postgres(writer) => {
                    sqlx::query(&format!("DELETE FROM {target} WHERE id=1")).execute(writer).await?;
                }
                DbPool::Mysql(writer) => {
                    sqlx::query(&format!("DELETE FROM {target} WHERE id=1")).execute(writer).await?;
                }
                _ => unreachable!(),
            }
            let second = snapshot.fetch_rows(&second_sql).await?;
            let first_last = first.last().and_then(|row| row[0].as_i64()).unwrap_or_default();
            let second_first = second.first().and_then(|row| row[0].as_i64()).unwrap_or_default();
            snapshot.finish().await?;
            Ok((first_last, second_first))
        }
        .await;
        let drop = format!("DROP TABLE IF EXISTS {target}");
        execute_snapshot_test_sql(&pool, &drop).await?;
        let (first_last, second_first) = read_result?;
        assert_eq!(first_last, 32);
        assert_eq!(second_first, 33);
        Ok(())
    }

    async fn execute_snapshot_test_sql(pool: &DbPool, sql: &str) -> AppResult<()> {
        match pool {
            DbPool::Postgres(pool) => { sqlx::raw_sql(sql).execute(pool).await?; }
            DbPool::Mysql(pool) => { sqlx::raw_sql(sql).execute(pool).await?; }
            _ => unreachable!(),
        }
        Ok(())
    }

    async fn mysql_myisam_source_disables_only_data_preview(pool: &sqlx::MySqlPool) -> AppResult<()> {
        let source_table = format!("rdb_myisam_{}", uuid::Uuid::new_v4().simple());
        let target_table = format!("rdb_copy_{}", uuid::Uuid::new_v4().simple());
        let source_quoted = data::quote_ident(DriverKind::Mysql, &source_table);
        sqlx::raw_sql(&format!("CREATE TABLE {source_quoted} (id BIGINT PRIMARY KEY) ENGINE=MyISAM"))
            .execute(pool)
            .await?;
        let result: AppResult<(bool, bool, Option<String>)> = async {
            let wrapped = DbPool::Mysql(pool.clone());
            let plan = preview(
                &wrapped,
                &wrapped,
                SyncRequest {
                    source_id: "mysql-source".into(),
                    target_id: "mysql-target".into(),
                    source_schema: None,
                    source_table: source_table.clone(),
                    target_schema: None,
                    target_table: target_table.clone(),
                    compare_deletes: false,
                },
            )
            .await?;
            Ok((plan.data_supported, plan.structure.supported, plan.data_reason))
        }
        .await;
        sqlx::raw_sql(&format!("DROP TABLE IF EXISTS {source_quoted}"))
            .execute(pool)
            .await?;
        let (data_supported, structure_supported, reason) = result?;
        assert!(!data_supported);
        assert!(structure_supported);
        assert!(reason.as_deref().is_some_and(|text| text.contains("consistent snapshot")));
        Ok(())
    }

    #[tokio::test]
    async fn postgres_snapshot_pages_hold_repeatable_read_during_concurrent_delete() {
        let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
            eprintln!("skip: RDBSTUDIO_TEST_PG_URL is not set");
            return;
        };
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(&url).await.unwrap();
        live_snapshot_concurrent_delete(DbPool::Postgres(pool.clone()), DriverKind::Postgres).await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn mysql_snapshot_pages_hold_repeatable_read_during_concurrent_delete() {
        let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
            eprintln!("skip: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is not set");
            return;
        };
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(2).connect(&url).await.unwrap();
        live_snapshot_concurrent_delete(DbPool::Mysql(pool.clone()), DriverKind::Mysql).await.unwrap();
        mysql_myisam_source_disables_only_data_preview(&pool).await.unwrap();
        pool.close().await;
    }

    #[test]
    fn escape_like_treats_wildcards_literally() {
        assert_eq!(escape_like("a!%_b\\c"), "a!!!%!_b\\c");
    }

    #[test]
    fn oversized_conflict_keys_are_bounded_for_ipc() {
        let sample = sample_key(&"x".repeat(10_000));
        assert_eq!(sample.len(), 256 + "…".len());
        assert!(sample.ends_with('…'));
    }

    #[test]
    fn arrays_and_unrecognized_types_fail_closed() {
        assert_eq!(type_family("integer[]"), None);
        let array = design::ColumnDetail {
            name: "items".into(),
            data_type: "text[]".into(),
            nullable: true,
            default: None,
            comment: None,
            ordinal_position: 0,
            char_max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            is_primary_key: false,
            is_auto_increment: false,
            is_identity: false,
            identity_generation: None,
        };
        assert!(target_type(DriverKind::Postgres, DriverKind::Mysql, &array).is_err());
        assert_eq!(type_family("interval"), None);
    }

    #[test]
    fn unsigned_integer_ranges_are_checked_before_transfer() {
        assert!(integer_fits("INT UNSIGNED", "BIGINT"));
        assert!(!integer_fits("BIGINT UNSIGNED", "BIGINT"));
        assert_eq!(integer_decimal_digits("BIGINT UNSIGNED"), Some(20));
        assert!(column_data_compatible(
            &design::ColumnDetail {
                name: "id".into(),
                data_type: "BIGINT UNSIGNED".into(),
                nullable: false,
                default: None,
                comment: None,
                ordinal_position: 0,
                char_max_length: None,
                numeric_precision: None,
                numeric_scale: None,
                is_primary_key: true,
                is_auto_increment: false,
                is_identity: false,
                identity_generation: None,
            },
            &design::ColumnDetail {
                name: "id".into(),
                data_type: "NUMERIC".into(),
                nullable: false,
                default: None,
                comment: None,
                ordinal_position: 0,
                char_max_length: None,
                numeric_precision: Some(20),
                numeric_scale: Some(0),
                is_primary_key: true,
                is_auto_increment: false,
                is_identity: false,
                identity_generation: None,
            },
        ));
    }

    #[test]
    fn sync_type_mapping_rejects_unsupported_identity_targets() {
        let col = design::ColumnDetail {
            name: "id".into(),
            data_type: "integer".into(),
            nullable: false,
            default: None,
            comment: None,
            ordinal_position: 0,
            char_max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            is_primary_key: true,
            is_auto_increment: false,
            is_identity: true,
            identity_generation: Some("ALWAYS".into()),
        };
        assert!(target_type(DriverKind::Postgres, DriverKind::Mysql, &col).is_err());
        assert_eq!(
            target_type(DriverKind::Postgres, DriverKind::Postgres, &col).unwrap(),
            "BIGINT"
        );
    }
}
