use crate::db::data::{self, quote_ident, TableQuery};
use crate::db::exec::QueryResult;
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use sqlx::Arguments;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportOptions {
    pub format: ExportFormat,
    pub path: String,
    #[serde(default = "default_delim")]
    pub delimiter: char,
    #[serde(default = "default_true")]
    pub include_header: bool,
    #[serde(default)]
    pub quote_all: bool,
    #[serde(default = "default_batch")]
    pub batch_size: u32,
    /// SQL format only: prepend the table's CREATE TABLE DDL so the file is a
    /// self-contained dump rather than bare INSERTs. Ignored for CSV/JSON.
    #[serde(default)]
    pub include_ddl: bool,
    /// SQL format only: include INSERT statements. Set this to false while
    /// `include_ddl` is true for a structure-only export.
    #[serde(default = "default_true")]
    pub include_data: bool,
}

fn default_delim() -> char {
    ','
}
fn default_true() -> bool {
    true
}
fn default_batch() -> u32 {
    5000
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportReport {
    pub rows_written: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}

pub async fn export_table(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
    opts: &ExportOptions,
) -> AppResult<ExportReport> {
    let start = std::time::Instant::now();

    if matches!(opts.format, ExportFormat::Sql) && !opts.include_ddl && !opts.include_data {
        return Err(AppError::msg(
            "SQL export must include table structure, data, or both",
        ));
    }

    // Fetch requested DDL before truncating the destination. In particular, a
    // structure-only failure must not leave an empty file reported as success.
    let ddl = if matches!(opts.format, ExportFormat::Sql) && opts.include_ddl {
        Some(crate::db::design::ddl(pool, schema, table).await?)
    } else {
        None
    };

    let file = File::create(&opts.path)?;
    let mut w = BufWriter::new(file);

    let mut offset: u32 = 0;
    let batch_size = data::bounded_table_limit(opts.batch_size);
    let mut rows: u64 = 0;
    let mut first = true;

    if let Some(ddl) = ddl {
        let ddl = ddl.trim_end();
        w.write_all(ddl.as_bytes())?;
        if !ddl.ends_with(';') {
            w.write_all(b";")?;
        }
        w.write_all(b"\n\n")?;
    }

    if matches!(opts.format, ExportFormat::Sql) && !opts.include_data {
        w.flush()?;
        let size = std::fs::metadata(&opts.path).map(|m| m.len()).unwrap_or(0);
        return Ok(ExportReport {
            rows_written: 0,
            bytes: size,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    // Deterministic paging: without a stable ORDER BY, LIMIT/OFFSET batches
    // can overlap or skip rows mid-export. Order by the first PK column when
    // the table has one; a table without a PK keeps the old best-effort scan.
    let order_by = crate::db::meta::list_columns(pool, schema, table)
        .await
        .ok()
        .and_then(|cols| cols.into_iter().find(|c| c.is_primary_key))
        .map(|c| data::OrderBy {
            column: c.name,
            direction: data::SortDir::Asc,
        });

    if let ExportFormat::Json = opts.format { w.write_all(b"[\n")? }

    loop {
        let q = TableQuery {
            schema: schema.map(String::from),
            table: table.to_string(),
            limit: batch_size,
            offset,
            order_by: order_by.clone(),
            filters: vec![],
            where_raw: None,
        };
        let r = data::fetch(pool, &q).await?;
        if first && !r.columns.is_empty() {
            write_header(&mut w, &r, opts)?;
            first = false;
        }
        if r.rows.is_empty() {
            break;
        }
        write_rows(&mut w, &r, opts, rows, schema, table, pool.driver())?;
        rows += r.rows.len() as u64;
        if r.rows.len() < batch_size as usize {
            break;
        }
        offset = offset
            .checked_add(batch_size)
            .ok_or_else(|| AppError::msg("export offset exceeds supported range"))?;
    }

    if let ExportFormat::Json = opts.format { w.write_all(b"\n]\n")? }

    w.flush()?;
    let size = std::fs::metadata(&opts.path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportReport {
        rows_written: rows,
        bytes: size,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

fn write_header(
    w: &mut BufWriter<File>,
    r: &QueryResult,
    opts: &ExportOptions,
) -> AppResult<()> {
    if !opts.include_header {
        return Ok(());
    }
    if let ExportFormat::Csv = opts.format {
        let line = r
            .columns
            .iter()
            .map(|c| csv_escape(&c.name, opts.delimiter, opts.quote_all))
            .collect::<Vec<_>>()
            .join(&opts.delimiter.to_string());
        w.write_all(line.as_bytes())?;
        w.write_all(b"\n")?;
    }
    Ok(())
}

fn write_rows(
    w: &mut BufWriter<File>,
    r: &QueryResult,
    opts: &ExportOptions,
    prior_rows: u64,
    schema: Option<&str>,
    table: &str,
    driver: DriverKind,
) -> AppResult<()> {
    match opts.format {
        ExportFormat::Csv => {
            for row in &r.rows {
                let parts: Vec<String> = row
                    .iter()
                    .map(|v| csv_val(v, opts.delimiter, opts.quote_all))
                    .collect();
                w.write_all(parts.join(&opts.delimiter.to_string()).as_bytes())?;
                w.write_all(b"\n")?;
            }
        }
        ExportFormat::Json => {
            for (i, row) in r.rows.iter().enumerate() {
                if prior_rows + (i as u64) > 0 {
                    w.write_all(b",\n")?;
                }
                let obj: serde_json::Map<String, serde_json::Value> = r
                    .columns
                    .iter()
                    .zip(row.iter())
                    .map(|(c, v)| (c.name.clone(), v.clone()))
                    .collect();
                let s = serde_json::to_string(&serde_json::Value::Object(obj))?;
                w.write_all(s.as_bytes())?;
            }
        }
        ExportFormat::Sql => {
            if r.columns.is_empty() {
                return Ok(());
            }
            // Quote identifiers in the source pool's dialect (MySQL → backticks,
            // PG/SQLite → double quotes) so a MySQL dump round-trips and its
            // INSERTs match the backtick-quoted CREATE TABLE prepended above.
            let target = match schema {
                Some(s) if !s.is_empty() => format!(
                    "{}.{}",
                    quote_ident(driver, s),
                    quote_ident(driver, table)
                ),
                _ => quote_ident(driver, table),
            };
            let col_list = r
                .columns
                .iter()
                .map(|c| quote_ident(driver, &c.name))
                .collect::<Vec<_>>()
                .join(", ");
            for row in &r.rows {
                let vals = row
                    .iter()
                    .map(|v| sql_literal(v, driver))
                    .collect::<Vec<_>>()
                    .join(", ");
                let line = format!("INSERT INTO {} ({}) VALUES ({});\n", target, col_list, vals);
                w.write_all(line.as_bytes())?;
            }
        }
    }
    Ok(())
}

fn csv_val(v: &serde_json::Value, delim: char, quote_all: bool) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => csv_escape(s, delim, quote_all),
        serde_json::Value::Bool(b) => csv_escape(if *b { "true" } else { "false" }, delim, quote_all),
        other => csv_escape(&other.to_string(), delim, quote_all),
    }
}

fn csv_escape(s: &str, delim: char, quote_all: bool) -> String {
    let needs_quote = quote_all
        || s.contains(delim)
        || s.contains('"')
        || s.contains('\n')
        || s.contains('\r');
    if needs_quote {
        let escaped = s.replace('"', "\"\"");
        format!("\"{}\"", escaped)
    } else {
        s.to_string()
    }
}

fn sql_literal(v: &serde_json::Value, driver: DriverKind) -> String {
    match v {
        serde_json::Value::Null => "NULL".into(),
        serde_json::Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => {
            let mut t = s.replace('\'', "''");
            if driver == DriverKind::Mysql {
                t = t.replace('\\', "\\\\");
            }
            format!("'{t}'")
        }
        other => {
            let mut t = other.to_string().replace('\'', "''");
            if driver == DriverKind::Mysql {
                t = t.replace('\\', "\\\\");
            }
            format!("'{t}'")
        }
    }
}

// ----- Import CSV -----

#[derive(Debug, Clone, Deserialize)]
pub enum ImportMode {
    #[serde(rename = "append")]
    Append,
    #[serde(rename = "truncate_insert")]
    TruncateInsert,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportCsvOptions {
    pub path: String,
    pub schema: Option<String>,
    pub table: String,
    #[serde(default = "default_delim")]
    pub delimiter: char,
    #[serde(default = "default_true")]
    pub has_header: bool,
    pub mode: ImportMode,
    /// Optional mapping: index in CSV row -> target column name.
    /// If omitted, headers (if present) are matched to columns by name.
    /// If no headers AND no mapping, columns are used in order.
    #[serde(default)]
    pub column_map: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub rows_read: u64,
    pub rows_inserted: u64,
    pub errors: Vec<String>,
    pub elapsed_ms: u64,
}

pub async fn import_csv(
    pool: &DbPool,
    opts: &ImportCsvOptions,
) -> AppResult<ImportReport> {
    let driver = pool.driver();
    let start = std::time::Instant::now();
    let target = match opts.schema.as_deref() {
        Some(s) if !s.is_empty() => format!(
            "{}.{}",
            quote_ident(driver, s),
            quote_ident(driver, &opts.table)
        ),
        _ => quote_ident(driver, &opts.table),
    };

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(opts.delimiter as u8)
        .has_headers(opts.has_header)
        .flexible(true)
        .from_path(Path::new(&opts.path))?;

    let (columns, source_indices): (Vec<String>, Vec<usize>) = if let Some(m) = &opts.column_map {
        let mut seen = HashSet::new();
        let mut columns = Vec::new();
        let mut source_indices = Vec::new();
        for (index, target) in m.iter().enumerate() {
            // The import dialog represents "skip this CSV column" as an empty
            // target. Keep the original source index for every retained field.
            if target.is_empty() {
                continue;
            }
            if !seen.insert(target.clone()) {
                return Err(AppError::msg(format!(
                    "target column is mapped more than once: {}",
                    target
                )));
            }
            columns.push(target.clone());
            source_indices.push(index);
        }
        (columns, source_indices)
    } else if opts.has_header {
        let columns: Vec<String> = rdr.headers()?.iter().map(|s| s.to_string()).collect();
        let source_indices = (0..columns.len()).collect();
        (columns, source_indices)
    } else {
        return Err(AppError::msg(
            "CSV has no headers and no column_map provided",
        ));
    };
    if columns.is_empty() {
        return Err(AppError::msg("no target columns"));
    }

    let col_list = columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=columns.len())
        .map(|i| match driver {
            DriverKind::Postgres => format!("${}", i),
            _ => "?".into(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let insert_sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        target, col_list, placeholders
    );

    // Multi-row VALUES batching: hundreds of rows per INSERT instead of one
    // round-trip per row. The bind budget stays under SQLite's classic
    // 999-parameter limit, the lowest across our drivers.
    let rows_per_batch = (900 / columns.len()).max(1);

    let mut rows_read: u64 = 0;
    let mut rows_inserted: u64 = 0;
    let mut errors: Vec<String> = Vec::new();

    match pool {
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Import CSV"),
        DbPool::Sqlite(p) => {
            let mut tx = p.begin().await?;
            if matches!(opts.mode, ImportMode::TruncateInsert) {
                sqlx::query(&format!("DELETE FROM {}", target))
                    .execute(&mut *tx)
                    .await?;
            }
            let full_sql =
                multi_insert_sql(&target, &col_list, columns.len(), rows_per_batch, driver);
            let mut batch: Vec<csv::StringRecord> = Vec::with_capacity(rows_per_batch);
            let mut first_row: u64 = 0;
            for result in rdr.records() {
                rows_read += 1;
                let rec = match result {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(format!("row {}: {}", rows_read, e));
                        continue;
                    }
                };
                if batch.is_empty() {
                    first_row = rows_read;
                }
                batch.push(project_csv_record(&rec, &source_indices));
                if batch.len() >= rows_per_batch {
                    flush_batch_sqlite(
                        &mut tx,
                        &full_sql,
                        &insert_sql,
                        columns.len(),
                        &batch,
                        first_row,
                        &mut rows_inserted,
                        &mut errors,
                    )
                    .await?;
                    batch.clear();
                }
            }
            if !batch.is_empty() {
                let tail_sql =
                    multi_insert_sql(&target, &col_list, columns.len(), batch.len(), driver);
                flush_batch_sqlite(
                    &mut tx,
                    &tail_sql,
                    &insert_sql,
                    columns.len(),
                    &batch,
                    first_row,
                    &mut rows_inserted,
                    &mut errors,
                )
                .await?;
            }
            tx.commit().await?;
        }
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await?;
            if matches!(opts.mode, ImportMode::TruncateInsert) {
                sqlx::query(&format!("TRUNCATE TABLE {}", target))
                    .execute(&mut *tx)
                    .await?;
            }
            let full_sql =
                multi_insert_sql(&target, &col_list, columns.len(), rows_per_batch, driver);
            let mut batch: Vec<csv::StringRecord> = Vec::with_capacity(rows_per_batch);
            let mut first_row: u64 = 0;
            for result in rdr.records() {
                rows_read += 1;
                let rec = match result {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(format!("row {}: {}", rows_read, e));
                        continue;
                    }
                };
                if batch.is_empty() {
                    first_row = rows_read;
                }
                batch.push(project_csv_record(&rec, &source_indices));
                if batch.len() >= rows_per_batch {
                    flush_batch_pg(
                        &mut tx,
                        &full_sql,
                        &insert_sql,
                        columns.len(),
                        &batch,
                        first_row,
                        &mut rows_inserted,
                        &mut errors,
                    )
                    .await?;
                    batch.clear();
                }
            }
            if !batch.is_empty() {
                let tail_sql =
                    multi_insert_sql(&target, &col_list, columns.len(), batch.len(), driver);
                flush_batch_pg(
                    &mut tx,
                    &tail_sql,
                    &insert_sql,
                    columns.len(),
                    &batch,
                    first_row,
                    &mut rows_inserted,
                    &mut errors,
                )
                .await?;
            }
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            let mut tx = p.begin().await?;
            if matches!(opts.mode, ImportMode::TruncateInsert) {
                // MySQL TRUNCATE implicitly commits, so a later CSV/connection
                // failure could permanently empty the table despite rollback.
                sqlx::query(&clear_table_sql(driver, &target))
                    .execute(&mut *tx)
                    .await?;
            }
            let full_sql =
                multi_insert_sql(&target, &col_list, columns.len(), rows_per_batch, driver);
            let mut batch: Vec<csv::StringRecord> = Vec::with_capacity(rows_per_batch);
            let mut first_row: u64 = 0;
            for result in rdr.records() {
                rows_read += 1;
                let rec = match result {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(format!("row {}: {}", rows_read, e));
                        continue;
                    }
                };
                if batch.is_empty() {
                    first_row = rows_read;
                }
                batch.push(project_csv_record(&rec, &source_indices));
                if batch.len() >= rows_per_batch {
                    flush_batch_mysql(
                        &mut tx,
                        &full_sql,
                        &insert_sql,
                        columns.len(),
                        &batch,
                        first_row,
                        &mut rows_inserted,
                        &mut errors,
                    )
                    .await?;
                    batch.clear();
                }
            }
            if !batch.is_empty() {
                let tail_sql =
                    multi_insert_sql(&target, &col_list, columns.len(), batch.len(), driver);
                flush_batch_mysql(
                    &mut tx,
                    &tail_sql,
                    &insert_sql,
                    columns.len(),
                    &batch,
                    first_row,
                    &mut rows_inserted,
                    &mut errors,
                )
                .await?;
            }
            tx.commit().await?;
        }
    }

    Ok(ImportReport {
        rows_read,
        rows_inserted,
        errors,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

fn project_csv_record(record: &csv::StringRecord, source_indices: &[usize]) -> csv::StringRecord {
    let mut projected = csv::StringRecord::new();
    for index in source_indices {
        projected.push_field(record.get(*index).unwrap_or(""));
    }
    projected
}

fn clear_table_sql(driver: DriverKind, target: &str) -> String {
    match driver {
        DriverKind::Postgres => format!("TRUNCATE TABLE {}", target),
        // SQLite has no TRUNCATE. MySQL's TRUNCATE is DDL and implicitly
        // commits, so DELETE is required to preserve import rollback safety.
        DriverKind::Sqlite | DriverKind::Mysql => format!("DELETE FROM {}", target),
        DriverKind::Redis => String::new(),
    }
}

/// Build a multi-row `INSERT INTO t (cols) VALUES (...), (...)` statement with
/// driver-appropriate placeholders (numbered for PG, `?` elsewhere).
fn multi_insert_sql(
    target: &str,
    col_list: &str,
    ncols: usize,
    nrows: usize,
    driver: DriverKind,
) -> String {
    let mut s = format!("INSERT INTO {} ({}) VALUES ", target, col_list);
    for r in 0..nrows {
        if r > 0 {
            s.push_str(", ");
        }
        s.push('(');
        for c in 0..ncols {
            if c > 0 {
                s.push_str(", ");
            }
            match driver {
                DriverKind::Postgres => {
                    s.push('$');
                    s.push_str(&(r * ncols + c + 1).to_string());
                }
                _ => s.push('?'),
            }
        }
        s.push(')');
    }
    s
}

// Insert a batch with one multi-row INSERT; if the batch fails, roll it back
// to a savepoint and replay row-by-row so per-row errors stay precise and the
// good rows still land. Row-level savepoints keep a bad row from aborting the
// surrounding transaction (Postgres in particular poisons the tx otherwise).
macro_rules! flush_batch_impl {
    ($fn_name:ident, $db:ty, $args:ty) => {
        #[allow(clippy::too_many_arguments)]
        async fn $fn_name(
            tx: &mut sqlx::Transaction<'_, $db>,
            batch_sql: &str,
            single_sql: &str,
            ncols: usize,
            batch: &[csv::StringRecord],
            first_row: u64,
            rows_inserted: &mut u64,
            errors: &mut Vec<String>,
        ) -> AppResult<()> {
            let mut args = <$args>::default();
            for rec in batch {
                for i in 0..ncols {
                    let v = rec.get(i).unwrap_or("");
                    let bind: Option<String> = if v.is_empty() { None } else { Some(v.into()) };
                    args.add(bind).map_err(|e| AppError::msg(e.to_string()))?;
                }
            }
            sqlx::query("SAVEPOINT rdb_csv_batch")
                .execute(&mut **tx)
                .await?;
            match sqlx::query_with(batch_sql, args).execute(&mut **tx).await {
                Ok(r) => {
                    *rows_inserted += r.rows_affected();
                    sqlx::query("RELEASE SAVEPOINT rdb_csv_batch")
                        .execute(&mut **tx)
                        .await?;
                }
                Err(_) => {
                    sqlx::query("ROLLBACK TO SAVEPOINT rdb_csv_batch")
                        .execute(&mut **tx)
                        .await?;
                    sqlx::query("RELEASE SAVEPOINT rdb_csv_batch")
                        .execute(&mut **tx)
                        .await?;
                    for (j, rec) in batch.iter().enumerate() {
                        let mut args = <$args>::default();
                        for i in 0..ncols {
                            let v = rec.get(i).unwrap_or("");
                            let bind: Option<String> =
                                if v.is_empty() { None } else { Some(v.into()) };
                            args.add(bind).map_err(|e| AppError::msg(e.to_string()))?;
                        }
                        sqlx::query("SAVEPOINT rdb_csv_row")
                            .execute(&mut **tx)
                            .await?;
                        match sqlx::query_with(single_sql, args).execute(&mut **tx).await {
                            Ok(_) => {
                                *rows_inserted += 1;
                                sqlx::query("RELEASE SAVEPOINT rdb_csv_row")
                                    .execute(&mut **tx)
                                    .await?;
                            }
                            Err(e) => {
                                errors.push(format!("row {}: {}", first_row + j as u64, e));
                                sqlx::query("ROLLBACK TO SAVEPOINT rdb_csv_row")
                                    .execute(&mut **tx)
                                    .await?;
                                sqlx::query("RELEASE SAVEPOINT rdb_csv_row")
                                    .execute(&mut **tx)
                                    .await?;
                            }
                        }
                    }
                }
            }
            Ok(())
        }
    };
}

flush_batch_impl!(flush_batch_sqlite, sqlx::Sqlite, sqlx::sqlite::SqliteArguments);
flush_batch_impl!(flush_batch_pg, sqlx::Postgres, sqlx::postgres::PgArguments);
flush_batch_impl!(flush_batch_mysql, sqlx::MySql, sqlx::mysql::MySqlArguments);

#[derive(Debug, Clone, Serialize)]
pub struct CsvPreview {
    pub headers: Option<Vec<String>>,
    pub sample_rows: Vec<Vec<String>>,
    pub total_sampled: u64,
}

pub fn preview_csv(path: &str, delimiter: char, has_header: bool, limit: usize) -> AppResult<CsvPreview> {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter as u8)
        .has_headers(has_header)
        .flexible(true)
        .from_path(Path::new(path))?;
    let headers = if has_header {
        Some(rdr.headers()?.iter().map(|s| s.to_string()).collect())
    } else {
        None
    };
    let mut sample = Vec::new();
    let mut total = 0u64;
    for r in rdr.records() {
        total += 1;
        if sample.len() < limit {
            let r = r?;
            sample.push(r.iter().map(|s| s.to_string()).collect());
        }
    }
    Ok(CsvPreview {
        headers,
        sample_rows: sample,
        total_sampled: total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_insert_sql_numbers_pg_and_uses_qmarks_elsewhere() {
        assert_eq!(
            multi_insert_sql("\"t\"", "\"a\", \"b\"", 2, 2, DriverKind::Postgres),
            "INSERT INTO \"t\" (\"a\", \"b\") VALUES ($1, $2), ($3, $4)"
        );
        assert_eq!(
            multi_insert_sql("`t`", "`a`", 1, 3, DriverKind::Mysql),
            "INSERT INTO `t` (`a`) VALUES (?), (?), (?)"
        );
    }

    #[test]
    fn clear_table_sql_keeps_mysql_transactional() {
        assert_eq!(
            clear_table_sql(DriverKind::Postgres, "\"t\""),
            "TRUNCATE TABLE \"t\""
        );
        assert_eq!(clear_table_sql(DriverKind::Mysql, "`t`"), "DELETE FROM `t`");
        assert_eq!(
            clear_table_sql(DriverKind::Sqlite, "\"t\""),
            "DELETE FROM \"t\""
        );
    }

    #[test]
    fn csv_escape_leaves_plain_unquoted() {
        assert_eq!(csv_escape("hello", ',', false), "hello");
    }

    #[test]
    fn csv_escape_quotes_when_delim_or_special() {
        assert_eq!(csv_escape("a,b", ',', false), "\"a,b\"");
        assert_eq!(csv_escape("line\n2", ',', false), "\"line\n2\"");
    }

    #[test]
    fn csv_escape_escapes_internal_quotes() {
        assert_eq!(csv_escape("say \"hi\"", ',', false), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn csv_escape_quote_all_forces_quoting() {
        assert_eq!(csv_escape("plain", ',', true), "\"plain\"");
    }

    #[test]
    fn sql_literal_null_bool_numbers_strings() {
        assert_eq!(sql_literal(&serde_json::Value::Null, DriverKind::Postgres), "NULL");
        assert_eq!(sql_literal(&serde_json::Value::Bool(true), DriverKind::Postgres), "TRUE");
        assert_eq!(sql_literal(&serde_json::Value::Bool(false), DriverKind::Postgres), "FALSE");
        assert_eq!(
            sql_literal(&serde_json::Value::from(42i64), DriverKind::Postgres),
            "42"
        );
        assert_eq!(
            sql_literal(&serde_json::Value::String("o'clock".into()), DriverKind::Postgres),
            "'o''clock'"
        );
        assert_eq!(
            sql_literal(
                &serde_json::Value::String(r"C:\name".into()),
                DriverKind::Mysql
            ),
            r"'C:\\name'"
        );
        assert_eq!(
            sql_literal(
                &serde_json::Value::String(r"C:\name".into()),
                DriverKind::Postgres
            ),
            r"'C:\name'"
        );
    }
}
