use crate::db::exec::{self, QueryResult};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use sqlx::Arguments;
use std::time::Instant;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrderBy {
    pub column: String,
    pub direction: SortDir,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Neq,
    Contains,
    StartsWith,
    EndsWith,
    Gt,
    Gte,
    Lt,
    Lte,
    IsNull,
    NotNull,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Filter {
    pub column: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TableQuery {
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    #[serde(default = "default_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub order_by: Option<OrderBy>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// Raw WHERE clause (without the WHERE keyword). If present, filters are ignored.
    #[serde(default)]
    pub where_raw: Option<String>,
}

fn default_limit() -> u32 {
    100
}

pub fn quote_ident(driver: DriverKind, ident: &str) -> String {
    match driver {
        DriverKind::Mysql => format!("`{}`", ident.replace('`', "``")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

fn qualified(driver: DriverKind, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!(
            "{}.{}",
            quote_ident(driver, s),
            quote_ident(driver, table)
        ),
        _ => quote_ident(driver, table),
    }
}

/// Build a `DROP TABLE`/`DROP VIEW` statement with the identifier quoted for
/// the driver. Used by the `drop_object` command; kept here (next to the other
/// identifier helpers) so it can be unit-tested without a live pool.
pub fn drop_sql(driver: DriverKind, schema: Option<&str>, name: &str, view: bool) -> String {
    let kind = if view { "VIEW" } else { "TABLE" };
    format!("DROP {} {}", kind, qualified(driver, schema, name))
}

fn placeholder(driver: DriverKind, n: usize) -> String {
    match driver {
        DriverKind::Postgres => format!("${}", n),
        _ => "?".into(),
    }
}

struct Where {
    sql: String,
    values: Vec<String>,
}

fn build_where(driver: DriverKind, filters: &[Filter]) -> AppResult<Where> {
    if filters.is_empty() {
        return Ok(Where {
            sql: String::new(),
            values: vec![],
        });
    }
    let mut parts = Vec::new();
    let mut values = Vec::new();
    for f in filters {
        let col = quote_ident(driver, &f.column);
        match f.op {
            FilterOp::IsNull => parts.push(format!("{} IS NULL", col)),
            FilterOp::NotNull => parts.push(format!("{} IS NOT NULL", col)),
            _ => {
                let raw = f
                    .value
                    .clone()
                    .ok_or_else(|| AppError::msg("filter value required"))?;
                let (op, val) = match f.op {
                    FilterOp::Eq => ("=", raw),
                    FilterOp::Neq => ("<>", raw),
                    FilterOp::Gt => (">", raw),
                    FilterOp::Gte => (">=", raw),
                    FilterOp::Lt => ("<", raw),
                    FilterOp::Lte => ("<=", raw),
                    FilterOp::Contains => ("LIKE", format!("%{}%", raw)),
                    FilterOp::StartsWith => ("LIKE", format!("{}%", raw)),
                    FilterOp::EndsWith => ("LIKE", format!("%{}", raw)),
                    FilterOp::IsNull | FilterOp::NotNull => unreachable!(),
                };
                let ph = placeholder(driver, values.len() + 1);
                parts.push(format!("{} {} {}", col, op, ph));
                values.push(val);
            }
        }
    }
    Ok(Where {
        sql: format!(" WHERE {}", parts.join(" AND ")),
        values,
    })
}

pub async fn fetch(pool: &DbPool, q: &TableQuery) -> AppResult<QueryResult> {
    let driver = pool.driver();
    let target = qualified(driver, q.schema.as_deref(), &q.table);
    let w = match q.where_raw.as_deref() {
        Some(raw) if !raw.trim().is_empty() => Where {
            sql: format!(" WHERE {}", raw.trim()),
            values: vec![],
        },
        _ => build_where(driver, &q.filters)?,
    };
    let order = match &q.order_by {
        Some(o) => format!(
            " ORDER BY {} {}",
            quote_ident(driver, &o.column),
            match o.direction {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            }
        ),
        None => String::new(),
    };
    let sql = format!(
        "SELECT * FROM {}{}{} LIMIT {} OFFSET {}",
        target, w.sql, order, q.limit, q.offset
    );
    let start = Instant::now();
    let rows = run_with_binds(pool, &sql, &w.values).await?;
    let mut r = rows_to_result(pool, rows, start)?;
    // sqlx decodes columns from the first row, so an empty result loses
    // column metadata. Backfill from the table's schema so freshly-created
    // tables still render headers — but only on the natural "empty table"
    // path (first page, no filters); a filtered query that legitimately
    // matches zero rows doesn't need the extra information_schema round-trip.
    let unfiltered_first_page =
        q.offset == 0 && q.filters.is_empty() && q.where_raw.as_deref().unwrap_or("").trim().is_empty();
    if r.columns.is_empty() && unfiltered_first_page {
        if let Ok(cols) =
            crate::db::meta::list_columns(pool, q.schema.as_deref(), &q.table).await
        {
            r.columns = cols
                .into_iter()
                .map(|c| exec::ColumnMeta {
                    name: c.name,
                    data_type: c.data_type,
                })
                .collect();
        }
    }
    r.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(r)
}

pub async fn count(pool: &DbPool, q: &TableQuery) -> AppResult<u64> {
    let driver = pool.driver();
    let target = qualified(driver, q.schema.as_deref(), &q.table);
    let w = match q.where_raw.as_deref() {
        Some(raw) if !raw.trim().is_empty() => Where {
            sql: format!(" WHERE {}", raw.trim()),
            values: vec![],
        },
        _ => build_where(driver, &q.filters)?,
    };
    let sql = format!("SELECT count(*) FROM {}{}", target, w.sql);
    match pool {
        DbPool::Redis(_) => crate::db::redis_ops::unsupported("Count rows"),
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query_scalar::<_, i64>(&sql);
            for v in &w.values {
                q = q.bind(v);
            }
            let n: i64 = q.fetch_one(p).await?;
            Ok(n.max(0) as u64)
        }
        DbPool::Postgres(p) => {
            let mut q = sqlx::query_scalar::<_, i64>(&sql);
            for v in &w.values {
                q = q.bind(v);
            }
            let n: i64 = q.fetch_one(p).await?;
            Ok(n.max(0) as u64)
        }
        DbPool::Mysql(p) => {
            let mut q = sqlx::query_scalar::<_, i64>(&sql);
            for v in &w.values {
                q = q.bind(v);
            }
            let n: i64 = q.fetch_one(p).await?;
            Ok(n.max(0) as u64)
        }
    }
}

enum AnyRows {
    Sqlite(Vec<sqlx::sqlite::SqliteRow>),
    Postgres(Vec<sqlx::postgres::PgRow>),
    Mysql(Vec<sqlx::mysql::MySqlRow>),
}

async fn run_with_binds(
    pool: &DbPool,
    sql: &str,
    binds: &[String],
) -> AppResult<AnyRows> {
    match pool {
        DbPool::Redis(_) => crate::db::redis_ops::unsupported("Tabular fetch"),
        DbPool::Sqlite(p) => {
            let mut args = sqlx::sqlite::SqliteArguments::default();
            for v in binds {
                args.add(v.as_str()).map_err(|e| AppError::msg(e.to_string()))?;
            }
            let rows = sqlx::query_with(sql, args).fetch_all(p).await?;
            Ok(AnyRows::Sqlite(rows))
        }
        DbPool::Postgres(p) => {
            let mut args = sqlx::postgres::PgArguments::default();
            for v in binds {
                args.add(v.as_str()).map_err(|e| AppError::msg(e.to_string()))?;
            }
            let rows = sqlx::query_with(sql, args).fetch_all(p).await?;
            Ok(AnyRows::Postgres(rows))
        }
        DbPool::Mysql(p) => {
            let mut args = sqlx::mysql::MySqlArguments::default();
            for v in binds {
                args.add(v.as_str()).map_err(|e| AppError::msg(e.to_string()))?;
            }
            let rows = sqlx::query_with(sql, args).fetch_all(p).await?;
            Ok(AnyRows::Mysql(rows))
        }
    }
}

fn rows_to_result(_pool: &DbPool, rows: AnyRows, start: Instant) -> AppResult<QueryResult> {
    match rows {
        AnyRows::Sqlite(rs) => Ok(exec::decode_sqlite(rs, start)),
        AnyRows::Postgres(rs) => Ok(exec::decode_postgres(rs, start)),
        AnyRows::Mysql(rs) => Ok(exec::decode_mysql(rs, start)),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Edit {
    Update {
        pk: Vec<(String, serde_json::Value)>,
        set: Vec<(String, serde_json::Value)>,
    },
    Insert {
        values: Vec<(String, serde_json::Value)>,
    },
    Delete {
        pk: Vec<(String, serde_json::Value)>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct EditBatch {
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub edits: Vec<Edit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditResult {
    pub ok: bool,
    pub applied: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_at: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
enum BindValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
}

fn json_to_bind(v: &serde_json::Value) -> BindValue {
    match v {
        serde_json::Value::Null => BindValue::Null,
        serde_json::Value::Bool(b) => BindValue::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                BindValue::Int(i)
            } else if let Some(u) = n.as_u64() {
                if u <= i64::MAX as u64 {
                    BindValue::Int(u as i64)
                } else {
                    BindValue::Str(u.to_string())
                }
            } else if let Some(f) = n.as_f64() {
                BindValue::Float(f)
            } else {
                BindValue::Str(n.to_string())
            }
        }
        serde_json::Value::String(s) => BindValue::Str(s.clone()),
        other => BindValue::Str(other.to_string()),
    }
}

fn build_edit_sql_impl<F>(
    driver: DriverKind,
    schema: Option<&str>,
    table: &str,
    edit: &Edit,
    mut get_ph_and_bind: F,
) -> String
where
    F: FnMut(usize, &serde_json::Value) -> String,
{
    let target = qualified(driver, schema, table);
    match edit {
        Edit::Update { pk, set } => {
            let mut ph_n = 1usize;
            let set_parts: Vec<String> = set
                .iter()
                .map(|(c, v)| {
                    let ph = get_ph_and_bind(ph_n, v);
                    ph_n += 1;
                    format!("{} = {}", quote_ident(driver, c), ph)
                })
                .collect();
            let where_parts: Vec<String> = pk
                .iter()
                .map(|(c, v)| {
                    if v.is_null() {
                        format!("{} IS NULL", quote_ident(driver, c))
                    } else {
                        let ph = get_ph_and_bind(ph_n, v);
                        ph_n += 1;
                        format!("{} = {}", quote_ident(driver, c), ph)
                    }
                })
                .collect();
            format!(
                "UPDATE {} SET {} WHERE {}",
                target,
                set_parts.join(", "),
                where_parts.join(" AND ")
            )
        }
        Edit::Insert { values } => {
            let cols: Vec<String> = values
                .iter()
                .map(|(c, _)| quote_ident(driver, c))
                .collect();
            let mut ph_n = 1usize;
            let phs: Vec<String> = values
                .iter()
                .map(|(_, v)| {
                    let ph = get_ph_and_bind(ph_n, v);
                    ph_n += 1;
                    ph
                })
                .collect();
            format!(
                "INSERT INTO {} ({}) VALUES ({})",
                target,
                cols.join(", "),
                phs.join(", ")
            )
        }
        Edit::Delete { pk } => {
            let mut ph_n = 1usize;
            let parts: Vec<String> = pk
                .iter()
                .map(|(c, v)| {
                    if v.is_null() {
                        format!("{} IS NULL", quote_ident(driver, c))
                    } else {
                        let ph = get_ph_and_bind(ph_n, v);
                        ph_n += 1;
                        format!("{} = {}", quote_ident(driver, c), ph)
                    }
                })
                .collect();
            format!("DELETE FROM {} WHERE {}", target, parts.join(" AND "))
        }
    }
}

fn build_edit_sql(
    driver: DriverKind,
    schema: Option<&str>,
    table: &str,
    edit: &Edit,
) -> (String, Vec<BindValue>) {
    let mut binds = Vec::new();
    let sql = build_edit_sql_impl(driver, schema, table, edit, |ph_n, v| {
        binds.push(json_to_bind(v));
        placeholder(driver, ph_n)
    });
    (sql, binds)
}

fn bind_sqlite(
    args: &mut sqlx::sqlite::SqliteArguments<'_>,
    b: &BindValue,
) -> AppResult<()> {
    match b {
        BindValue::Null => args
            .add(Option::<String>::None)
            .map_err(|e| AppError::msg(e.to_string())),
        BindValue::Bool(v) => args.add(*v).map_err(|e| AppError::msg(e.to_string())),
        BindValue::Int(v) => args.add(*v).map_err(|e| AppError::msg(e.to_string())),
        BindValue::Float(v) => args.add(*v).map_err(|e| AppError::msg(e.to_string())),
        BindValue::Str(s) => args
            .add(s.clone())
            .map_err(|e| AppError::msg(e.to_string())),
    }
}

fn bind_pg(
    args: &mut sqlx::postgres::PgArguments,
    b: &BindValue,
) -> AppResult<()> {
    match b {
        BindValue::Null => args
            .add(Option::<String>::None)
            .map_err(|e| AppError::msg(e.to_string())),
        BindValue::Bool(v) => args.add(*v).map_err(|e| AppError::msg(e.to_string())),
        BindValue::Int(v) => args.add(*v).map_err(|e| AppError::msg(e.to_string())),
        BindValue::Float(v) => args.add(*v).map_err(|e| AppError::msg(e.to_string())),
        BindValue::Str(s) => args
            .add(s.clone())
            .map_err(|e| AppError::msg(e.to_string())),
    }
}

fn bind_mysql(
    args: &mut sqlx::mysql::MySqlArguments,
    b: &BindValue,
) -> AppResult<()> {
    match b {
        BindValue::Null => args
            .add(Option::<String>::None)
            .map_err(|e| AppError::msg(e.to_string())),
        BindValue::Bool(v) => args
            .add(if *v { 1i64 } else { 0i64 })
            .map_err(|e| AppError::msg(e.to_string())),
        BindValue::Int(v) => args.add(*v).map_err(|e| AppError::msg(e.to_string())),
        BindValue::Float(v) => args.add(*v).map_err(|e| AppError::msg(e.to_string())),
        BindValue::Str(s) => args
            .add(s.clone())
            .map_err(|e| AppError::msg(e.to_string())),
    }
}

/// A grid Update/Delete targets exactly one row. If its WHERE matches more
/// than one (e.g. a PK-less table where every column is used as the key and
/// duplicate rows exist), applying it would silently clobber siblings — so we
/// abort and surface the ambiguity instead. Inserts have no such expectation.
fn expects_single_row(edit: &Edit) -> bool {
    matches!(edit, Edit::Update { .. } | Edit::Delete { .. })
}

fn ambiguous_edit_result(idx: usize, n: u64, applied: u64) -> EditResult {
    EditResult {
        ok: false,
        applied,
        failed_at: Some(idx),
        error: Some(format!(
            "edit #{} matched {} rows but expected exactly 1 — aborted to avoid \
             overwriting duplicate rows (this table likely has no unique key)",
            idx + 1,
            n
        )),
    }
}

fn no_match_edit_result(idx: usize, applied: u64) -> EditResult {
    EditResult {
        ok: false,
        applied,
        failed_at: Some(idx),
        error: Some(format!(
            "edit #{} matched 0 rows — the row may have been changed or removed \
             since the grid was loaded. Refresh and try again.",
            idx + 1
        )),
    }
}

/// Classify the affected-row count for a grid Update/Delete (which targets
/// exactly one row). Returns an aborting result when the count is wrong:
/// `0` means the WHERE matched nothing — the row changed/was removed under us,
/// so silently reporting success would mislead the user; `>1` means it would
/// clobber duplicate siblings. `Some(..)` aborts the batch (the open tx rolls
/// back); `None` means the count is fine (exactly 1, or the edit is an Insert).
///
/// Note: sqlx negotiates `CLIENT_FOUND_ROWS` on MySQL (see sqlx-mysql
/// `connection::stream`), so `rows_affected()` reflects *matched* rows on all
/// four drivers — the `n == 0` / `n > 1` checks are reliable everywhere.
fn single_row_violation(edit: &Edit, idx: usize, n: u64, applied: u64) -> Option<EditResult> {
    if !expects_single_row(edit) {
        return None;
    }
    match n {
        0 => Some(no_match_edit_result(idx, applied)),
        1 => None,
        _ => Some(ambiguous_edit_result(idx, n, applied)),
    }
}

pub async fn apply_edits(pool: &DbPool, batch: &EditBatch) -> AppResult<EditResult> {
    let driver = pool.driver();
    let mut applied = 0u64;

    match pool {
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Apply edits"),
        DbPool::Sqlite(p) => {
            let mut tx = p.begin().await?;
            for (idx, e) in batch.edits.iter().enumerate() {
                let (sql, binds) =
                    build_edit_sql(driver, batch.schema.as_deref(), &batch.table, e);
                let mut args = sqlx::sqlite::SqliteArguments::default();
                for b in &binds {
                    bind_sqlite(&mut args, b)?;
                }
                match sqlx::query_with(&sql, args).execute(&mut *tx).await {
                    Ok(r) => {
                        let n = r.rows_affected();
                        if let Some(res) = single_row_violation(e, idx, n, applied) {
                            // tx is dropped without commit → rollback.
                            return Ok(res);
                        }
                        applied += n;
                    }
                    Err(e) => {
                        return Ok(EditResult {
                            ok: false,
                            applied,
                            failed_at: Some(idx),
                            error: Some(e.to_string()),
                        });
                    }
                }
            }
            tx.commit().await?;
        }
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await?;
            for (idx, e) in batch.edits.iter().enumerate() {
                let (sql, binds) =
                    build_edit_sql(driver, batch.schema.as_deref(), &batch.table, e);
                let mut args = sqlx::postgres::PgArguments::default();
                for b in &binds {
                    bind_pg(&mut args, b)?;
                }
                match sqlx::query_with(&sql, args).execute(&mut *tx).await {
                    Ok(r) => {
                        let n = r.rows_affected();
                        if let Some(res) = single_row_violation(e, idx, n, applied) {
                            // tx is dropped without commit → rollback.
                            return Ok(res);
                        }
                        applied += n;
                    }
                    Err(e) => {
                        return Ok(EditResult {
                            ok: false,
                            applied,
                            failed_at: Some(idx),
                            error: Some(e.to_string()),
                        });
                    }
                }
            }
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            let mut tx = p.begin().await?;
            for (idx, e) in batch.edits.iter().enumerate() {
                let (sql, binds) =
                    build_edit_sql(driver, batch.schema.as_deref(), &batch.table, e);
                let mut args = sqlx::mysql::MySqlArguments::default();
                for b in &binds {
                    bind_mysql(&mut args, b)?;
                }
                match sqlx::query_with(&sql, args).execute(&mut *tx).await {
                    Ok(r) => {
                        let n = r.rows_affected();
                        if let Some(res) = single_row_violation(e, idx, n, applied) {
                            // tx is dropped without commit → rollback.
                            return Ok(res);
                        }
                        applied += n;
                    }
                    Err(e) => {
                        return Ok(EditResult {
                            ok: false,
                            applied,
                            failed_at: Some(idx),
                            error: Some(e.to_string()),
                        });
                    }
                }
            }
            tx.commit().await?;
        }
    }

    Ok(EditResult {
        ok: true,
        applied,
        failed_at: None,
        error: None,
    })
}

pub fn preview_edit_sql(
    driver: DriverKind,
    schema: Option<&str>,
    table: &str,
    edit: &Edit,
) -> String {
    build_edit_sql_impl(driver, schema, table, edit, |_ph_n, v| {
        match json_to_bind(v) {
            BindValue::Null => "NULL".into(),
            BindValue::Bool(b) => if b { "TRUE".to_string() } else { "FALSE".to_string() },
            BindValue::Int(v) => v.to_string(),
            BindValue::Float(v) => v.to_string(),
            BindValue::Str(s) => format!("'{}'", s.replace('\'', "''")),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DriverKind;

    #[test]
    fn quote_ident_mysql_uses_backticks_and_escapes() {
        assert_eq!(quote_ident(DriverKind::Mysql, "users"), "`users`");
        assert_eq!(quote_ident(DriverKind::Mysql, "we`ird"), "`we``ird`");
    }

    #[test]
    fn quote_ident_other_drivers_use_double_quotes_and_escape() {
        assert_eq!(quote_ident(DriverKind::Sqlite, "users"), "\"users\"");
        assert_eq!(quote_ident(DriverKind::Postgres, "users"), "\"users\"");
        assert_eq!(quote_ident(DriverKind::Sqlite, "we\"ird"), "\"we\"\"ird\"");
        assert_eq!(
            quote_ident(DriverKind::Postgres, "we\"ird"),
            "\"we\"\"ird\""
        );
    }

    #[test]
    fn placeholder_postgres_numbered() {
        assert_eq!(placeholder(DriverKind::Postgres, 1), "$1");
        assert_eq!(placeholder(DriverKind::Postgres, 5), "$5");
    }

    #[test]
    fn placeholder_sqlite_mysql_question_mark() {
        assert_eq!(placeholder(DriverKind::Sqlite, 1), "?");
        assert_eq!(placeholder(DriverKind::Sqlite, 9), "?");
        assert_eq!(placeholder(DriverKind::Mysql, 1), "?");
    }

    #[test]
    fn qualified_with_schema() {
        assert_eq!(
            qualified(DriverKind::Postgres, Some("public"), "users"),
            "\"public\".\"users\""
        );
        assert_eq!(
            qualified(DriverKind::Mysql, Some("db1"), "users"),
            "`db1`.`users`"
        );
    }

    #[test]
    fn drop_sql_table_and_view_quote_and_qualify() {
        assert_eq!(
            drop_sql(DriverKind::Postgres, Some("public"), "users", false),
            "DROP TABLE \"public\".\"users\""
        );
        assert_eq!(
            drop_sql(DriverKind::Postgres, Some("public"), "v_users", true),
            "DROP VIEW \"public\".\"v_users\""
        );
        assert_eq!(
            drop_sql(DriverKind::Sqlite, None, "users", false),
            "DROP TABLE \"users\""
        );
        assert_eq!(
            drop_sql(DriverKind::Mysql, Some("db1"), "ord`ers", false),
            "DROP TABLE `db1`.`ord``ers`"
        );
    }

    #[test]
    fn qualified_without_schema() {
        assert_eq!(
            qualified(DriverKind::Sqlite, None, "users"),
            "\"users\""
        );
        assert_eq!(
            qualified(DriverKind::Sqlite, Some(""), "users"),
            "\"users\""
        );
    }

    #[test]
    fn single_row_violation_classifies_affected_count() {
        let update = Edit::Update { pk: vec![], set: vec![] };
        let delete = Edit::Delete { pk: vec![] };
        let insert = Edit::Insert { values: vec![] };

        // Exactly one matched row → fine.
        assert!(single_row_violation(&update, 0, 1, 0).is_none());
        assert!(single_row_violation(&delete, 0, 1, 0).is_none());

        // Zero matched rows → surfaced as a stale-row error (not silent success).
        let zero = single_row_violation(&update, 2, 0, 5).expect("0 rows must abort");
        assert!(!zero.ok);
        assert_eq!(zero.applied, 5);
        assert_eq!(zero.failed_at, Some(2));
        assert!(zero.error.unwrap().contains("0 rows"));

        // More than one matched row → ambiguity guard.
        let many = single_row_violation(&delete, 0, 3, 0).expect(">1 row must abort");
        assert!(!many.ok);
        assert!(many.error.unwrap().contains("matched 3 rows"));

        // Inserts have no single-row expectation, even at 0 or many rows.
        assert!(single_row_violation(&insert, 0, 0, 0).is_none());
        assert!(single_row_violation(&insert, 0, 2, 0).is_none());
    }
}
