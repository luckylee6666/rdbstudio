use crate::db::data::{self, quote_ident, TableQuery};
use crate::db::exec::QueryResult;
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use sqlx::Arguments;
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
    let file = File::create(&opts.path)?;
    let mut w = BufWriter::new(file);

    let mut offset: u32 = 0;
    let mut rows: u64 = 0;
    let mut first = true;

    match opts.format {
        ExportFormat::Json => w.write_all(b"[\n")?,
        _ => {}
    }

    loop {
        let q = TableQuery {
            schema: schema.map(String::from),
            table: table.to_string(),
            limit: opts.batch_size,
            offset,
            order_by: None,
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
        write_rows(&mut w, &r, opts, rows, schema, table)?;
        rows += r.rows.len() as u64;
        if r.rows.len() < opts.batch_size as usize {
            break;
        }
        offset += opts.batch_size;
    }

    match opts.format {
        ExportFormat::Json => w.write_all(b"\n]\n")?,
        _ => {}
    }

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
    match opts.format {
        ExportFormat::Csv => {
            let line = r
                .columns
                .iter()
                .map(|c| csv_escape(&c.name, opts.delimiter, opts.quote_all))
                .collect::<Vec<_>>()
                .join(&opts.delimiter.to_string());
            w.write_all(line.as_bytes())?;
            w.write_all(b"\n")?;
        }
        _ => {}
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
            let driver = DriverKind::Postgres; // output uses double-quoted idents (PG/SQLite style)
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
                    .map(sql_literal)
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

fn sql_literal(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "NULL".into(),
        serde_json::Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
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

    let columns: Vec<String> = if let Some(m) = &opts.column_map {
        m.clone()
    } else if opts.has_header {
        rdr.headers()?.iter().map(|s| s.to_string()).collect()
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
            for result in rdr.records() {
                rows_read += 1;
                let rec = match result {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(format!("row {}: {}", rows_read, e));
                        continue;
                    }
                };
                let mut args = sqlx::sqlite::SqliteArguments::default();
                for i in 0..columns.len() {
                    let v = rec.get(i).unwrap_or("");
                    let bind: Option<String> = if v.is_empty() { None } else { Some(v.into()) };
                    args.add(bind)
                        .map_err(|e| AppError::msg(e.to_string()))?;
                }
                match sqlx::query_with(&insert_sql, args).execute(&mut *tx).await {
                    Ok(_) => rows_inserted += 1,
                    Err(e) => errors.push(format!("row {}: {}", rows_read, e)),
                }
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
            for result in rdr.records() {
                rows_read += 1;
                let rec = match result {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(format!("row {}: {}", rows_read, e));
                        continue;
                    }
                };
                let mut args = sqlx::postgres::PgArguments::default();
                for i in 0..columns.len() {
                    let v = rec.get(i).unwrap_or("");
                    let bind: Option<String> = if v.is_empty() { None } else { Some(v.into()) };
                    args.add(bind)
                        .map_err(|e| AppError::msg(e.to_string()))?;
                }
                match sqlx::query_with(&insert_sql, args).execute(&mut *tx).await {
                    Ok(_) => rows_inserted += 1,
                    Err(e) => errors.push(format!("row {}: {}", rows_read, e)),
                }
            }
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            let mut tx = p.begin().await?;
            if matches!(opts.mode, ImportMode::TruncateInsert) {
                sqlx::query(&format!("TRUNCATE TABLE {}", target))
                    .execute(&mut *tx)
                    .await?;
            }
            for result in rdr.records() {
                rows_read += 1;
                let rec = match result {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(format!("row {}: {}", rows_read, e));
                        continue;
                    }
                };
                let mut args = sqlx::mysql::MySqlArguments::default();
                for i in 0..columns.len() {
                    let v = rec.get(i).unwrap_or("");
                    let bind: Option<String> = if v.is_empty() { None } else { Some(v.into()) };
                    args.add(bind)
                        .map_err(|e| AppError::msg(e.to_string()))?;
                }
                match sqlx::query_with(&insert_sql, args).execute(&mut *tx).await {
                    Ok(_) => rows_inserted += 1,
                    Err(e) => errors.push(format!("row {}: {}", rows_read, e)),
                }
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
        assert_eq!(sql_literal(&serde_json::Value::Null), "NULL");
        assert_eq!(sql_literal(&serde_json::Value::Bool(true)), "TRUE");
        assert_eq!(sql_literal(&serde_json::Value::Bool(false)), "FALSE");
        assert_eq!(
            sql_literal(&serde_json::Value::from(42i64)),
            "42"
        );
        assert_eq!(
            sql_literal(&serde_json::Value::String("o'clock".into())),
            "'o''clock'"
        );
    }
}
