//! Typed, bounded imports for JSON, XML and Excel. CSV retains its streaming path.
use crate::db::{
    data,
    io::{CsvPreview, ImportMode, ImportReport},
    pool::DbPool,
};
use crate::error::{AppError, AppResult};
use calamine::{Data, Reader};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;

const MAX_FILE: u64 = 32 * 1024 * 1024;
const MAX_ROWS: usize = 20_000;

#[derive(Deserialize)]
pub struct ImportFileOptions {
    pub path: String,
    pub schema: Option<String>,
    pub table: String,
    pub mode: ImportMode,
    pub column_map: Vec<String>,
    pub sheet: Option<String>,
    #[serde(default = "yes")]
    pub has_header: bool,
}
fn yes() -> bool {
    true
}
#[derive(Serialize)]
pub struct FilePreview {
    #[serde(flatten)]
    pub preview: CsvPreview,
    pub sheets: Vec<String>,
}
struct Input {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    sheets: Vec<String>,
}

fn checked_file(path: &str) -> AppResult<()> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return Err(AppError::msg("import file must be at most 32 MiB"));
    }
    Ok(())
}
fn from_objects(objects: Vec<Map<String, Value>>) -> AppResult<Input> {
    if objects.len() > MAX_ROWS {
        return Err(AppError::msg(
            "import supports at most 20,000 rows per file",
        ));
    }
    let mut columns = Vec::new();
    for object in &objects {
        for name in object.keys() {
            if !columns.contains(name) {
                columns.push(name.clone());
            }
        }
    }
    if columns.len() > 512 {
        return Err(AppError::msg("import supports at most 512 columns"));
    }
    let rows = objects
        .into_iter()
        .map(|mut row| {
            columns
                .iter()
                .map(|name| preserve_number(row.remove(name).unwrap_or(Value::Null)))
                .collect()
        })
        .collect();
    Ok(Input {
        columns,
        rows,
        sheets: vec![],
    })
}
fn preserve_number(value: Value) -> Value {
    match value {
        Value::Number(ref number) if number.as_i64().is_none() && number.as_u64().is_none() => {
            Value::String(number.to_string())
        }
        other => other,
    }
}
fn load(path: &str, sheet: Option<&str>, has_header: bool) -> AppResult<Input> {
    checked_file(path)?;
    let extension = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "json" => {
            let data: Value = serde_json::from_reader(std::fs::File::open(path)?)?;
            let records = data
                .as_array()
                .ok_or_else(|| AppError::msg("JSON must be an array of row objects"))?;
            let objects = records
                .iter()
                .map(|r| {
                    r.as_object()
                        .cloned()
                        .ok_or_else(|| AppError::msg("each JSON row must be an object"))
                })
                .collect::<AppResult<Vec<_>>>()?;
            from_objects(objects)
        }
        "xml" => load_xml(&std::fs::read_to_string(path)?),
        "xlsx" | "xls" | "ods" => {
            if extension != "xls" {
                let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?)
                    .map_err(|e| AppError::msg(e.to_string()))?;
                let mut unpacked = 0u64;
                if archive.len() > 10_000 {
                    return Err(AppError::msg("workbook contains too many archive entries"));
                }
                for index in 0..archive.len() {
                    unpacked = unpacked.saturating_add(
                        archive
                            .by_index(index)
                            .map_err(|e| AppError::msg(e.to_string()))?
                            .size(),
                    );
                    if unpacked > 128 * 1024 * 1024 {
                        return Err(AppError::msg("uncompressed workbook exceeds 128 MiB"));
                    }
                }
            }
            let mut workbook =
                calamine::open_workbook_auto(path).map_err(|e| AppError::msg(e.to_string()))?;
            let sheets = workbook.sheet_names().to_vec();
            let name = sheet
                .or_else(|| sheets.first().map(String::as_str))
                .ok_or_else(|| AppError::msg("workbook has no worksheets"))?;
            let range = workbook
                .worksheet_range(name)
                .map_err(|e| AppError::msg(e.to_string()))?;
            if range.height() > MAX_ROWS + 1 || range.width() > 512 {
                return Err(AppError::msg(
                    "worksheet exceeds 20,000 rows or 512 columns",
                ));
            }
            let mut rows: Vec<Vec<Value>> = range
                .rows()
                .map(|row| row.iter().map(cell).collect())
                .collect();
            let columns = if has_header && !rows.is_empty() {
                rows.remove(0)
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .collect()
            } else {
                (0..range.width())
                    .map(|n| format!("column_{}", n + 1))
                    .collect()
            };
            Ok(Input {
                columns,
                rows,
                sheets,
            })
        }
        _ => Err(AppError::msg(
            "choose JSON, XML, XLSX, XLS or ODS for this importer",
        )),
    }
}
fn cell(data: &Data) -> Value {
    match data {
        Data::Empty => Value::Null,
        Data::Bool(v) => Value::Bool(*v),
        Data::Int(v) if v.unsigned_abs() > 9_007_199_254_740_991 => Value::String(v.to_string()),
        Data::Int(v) => Value::from(*v),
        Data::Float(v) => Value::from(*v),
        Data::DateTime(value) => Value::String(
            value
                .as_datetime()
                .map(|d| d.to_string())
                .unwrap_or_else(|| value.to_string()),
        ),
        _ => Value::String(data.to_string()),
    }
}
fn load_xml(xml: &str) -> AppResult<Input> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut rows = Vec::new();
    let mut row: Option<Map<String, Value>> = None;
    let mut field: Option<(String, bool, String)> = None;
    let mut depth = 0;
    loop {
        match reader
            .read_event()
            .map_err(|e| AppError::msg(e.to_string()))?
        {
            Event::DocType(_) => return Err(AppError::msg("XML DTDs are not allowed")),
            Event::Start(e) => {
                depth += 1;
                if depth > 8 {
                    return Err(AppError::msg("XML nesting exceeds the import limit"));
                }
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if name == "row" {
                    if row.is_some() {
                        return Err(AppError::msg("nested XML rows are not supported"));
                    }
                    row = Some(Map::new());
                } else if row.is_some() {
                    if field.is_some() {
                        return Err(AppError::msg("XML row fields must contain plain text"));
                    }
                    let mut column = name;
                    let mut null = false;
                    for a in e.attributes() {
                        let a = a.map_err(|e| AppError::msg(e.to_string()))?;
                        let value = a
                            .decode_and_unescape_value(reader.decoder())
                            .map_err(|e| AppError::msg(e.to_string()))?;
                        if a.key.as_ref() == b"name" {
                            column = value.into_owned();
                        } else if a.key.as_ref() == b"null" {
                            null = value == "true";
                        }
                    }
                    field = Some((column, null, String::new()));
                }
            }
            Event::Empty(e) if row.is_some() => {
                let mut name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                let mut null = false;
                for attribute in e.attributes() {
                    let attribute = attribute.map_err(|e| AppError::msg(e.to_string()))?;
                    let value = attribute
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|e| AppError::msg(e.to_string()))?;
                    if attribute.key.as_ref() == b"name" {
                        name = value.into_owned();
                    } else if attribute.key.as_ref() == b"null" {
                        null = value == "true";
                    }
                }
                if row
                    .as_mut()
                    .unwrap()
                    .insert(
                        name,
                        if null {
                            Value::Null
                        } else {
                            Value::String(String::new())
                        },
                    )
                    .is_some()
                {
                    return Err(AppError::msg("duplicate XML field"));
                }
            }
            Event::Text(e) => {
                if let Some((_, _, value)) = field.as_mut() {
                    let decoded = e.decode().map_err(|e| AppError::msg(e.to_string()))?;
                    value.push_str(
                        &quick_xml::escape::unescape(&decoded)
                            .map_err(|e| AppError::msg(e.to_string()))?,
                    );
                }
            }
            Event::GeneralRef(e) => {
                if let Some((_, _, value)) = field.as_mut() {
                    let name = e.decode().map_err(|e| AppError::msg(e.to_string()))?;
                    let reference = format!("&{name};");
                    value.push_str(
                        &quick_xml::escape::unescape(&reference)
                            .map_err(|e| AppError::msg(e.to_string()))?,
                    );
                }
            }
            Event::CData(e) => {
                if let Some((_, _, value)) = field.as_mut() {
                    value.push_str(&e.decode().map_err(|e| AppError::msg(e.to_string()))?);
                }
            }
            Event::End(e) => {
                if e.name().as_ref() == b"row" {
                    rows.push(row.take().ok_or_else(|| AppError::msg("invalid XML row"))?);
                    if rows.len() > MAX_ROWS {
                        return Err(AppError::msg("XML exceeds 20,000 rows"));
                    }
                } else if let Some((name, null, value)) = field.take() {
                    if row
                        .as_mut()
                        .ok_or_else(|| AppError::msg("invalid XML field"))?
                        .insert(
                            name,
                            if null {
                                Value::Null
                            } else {
                                Value::String(value)
                            },
                        )
                        .is_some()
                    {
                        return Err(AppError::msg("duplicate XML field"));
                    }
                }
                depth -= 1;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if row.is_some() || depth != 0 {
        return Err(AppError::msg("incomplete XML document"));
    }
    from_objects(rows)
}

pub fn preview_file(path: &str, sheet: Option<&str>, has_header: bool) -> AppResult<FilePreview> {
    let input = load(path, sheet, has_header)?;
    let total = input.rows.len();
    let sample_rows = input
        .rows
        .into_iter()
        .take(5)
        .map(|row| {
            row.into_iter()
                .map(|v| match v {
                    Value::String(s) => s,
                    Value::Null => "NULL".into(),
                    other => other.to_string(),
                })
                .collect()
        })
        .collect();
    Ok(FilePreview {
        preview: CsvPreview {
            headers: Some(input.columns),
            sample_rows,
            total_sampled: total as u64,
        },
        sheets: input.sheets,
    })
}

pub async fn import_file(pool: &DbPool, options: &ImportFileOptions) -> AppResult<ImportReport> {
    let start = Instant::now();
    let input = load(&options.path, options.sheet.as_deref(), options.has_header)?;
    let mut seen = HashSet::new();
    let mapping: Vec<(usize, String)> = options
        .column_map
        .iter()
        .enumerate()
        .filter(|(_, name)| !name.is_empty())
        .map(|(index, name)| (index, name.clone()))
        .collect();
    if mapping.is_empty() {
        return Err(AppError::msg("map at least one target column"));
    }
    if mapping
        .iter()
        .any(|(i, name)| *i >= input.columns.len() || !seen.insert(name.clone()))
    {
        return Err(AppError::msg("invalid or duplicate column mapping"));
    }
    let columns =
        crate::db::meta::list_columns(pool, options.schema.as_deref(), &options.table).await?;
    if mapping
        .iter()
        .any(|(_, name)| !columns.iter().any(|c| c.name == *name))
    {
        return Err(AppError::msg("mapped column does not exist"));
    }
    let edits: Vec<data::Edit> = input
        .rows
        .into_iter()
        .map(|row| data::Edit::Insert {
            values: mapping
                .iter()
                .map(|(index, name)| {
                    (
                        name.clone(),
                        row.get(*index).cloned().unwrap_or(Value::Null),
                    )
                })
                .collect(),
        })
        .collect();
    let types =
        Some(data::column_bind_types(pool, options.schema.as_deref(), &options.table).await?);
    let driver = pool.driver();
    let target = match options.schema.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => format!(
            "{}.{}",
            data::quote_ident(driver, s),
            data::quote_ident(driver, &options.table)
        ),
        None => data::quote_ident(driver, &options.table),
    };
    macro_rules! apply {
        ($pool:expr, $arguments:ty, $bind:path) => {{
            let mut transaction = $pool.begin().await?;
            if matches!(options.mode, ImportMode::TruncateInsert) {
                sqlx::query(&format!("DELETE FROM {target}"))
                    .execute(&mut *transaction)
                    .await?;
            }
            for (index, edit) in edits.iter().enumerate() {
                let (sql, values) = data::build_edit_sql(
                    driver,
                    options.schema.as_deref(),
                    &options.table,
                    edit,
                    types.as_ref(),
                );
                let mut arguments = <$arguments>::default();
                for value in &values {
                    $bind(&mut arguments, value)?;
                }
                sqlx::query_with(&sql, arguments)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|e| {
                        AppError::msg(format!("row {}: {e}; import rolled back", index + 1))
                    })?;
            }
            transaction.commit().await?;
        }};
    }
    match pool {
        DbPool::Sqlite(p) => apply!(p, sqlx::sqlite::SqliteArguments<'_>, data::bind_sqlite),
        DbPool::Postgres(p) => apply!(p, sqlx::postgres::PgArguments, data::bind_pg),
        DbPool::Mysql(p) => apply!(p, sqlx::mysql::MySqlArguments, data::bind_mysql),
        DbPool::Redis(_) => return Err(AppError::msg("table import is not supported for Redis")),
    }
    Ok(ImportReport {
        rows_read: edits.len() as u64,
        rows_inserted: edits.len() as u64,
        errors: vec![],
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}
