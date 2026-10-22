use crate::db::data::quote_ident;
use crate::db::io::multi_insert_sql;
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_GENERATE_ROWS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataGenRule {
    Skip,
    Null,
    Sequence,
    RandomInt,
    RandomFloat,
    Boolean,
    Uuid,
    FullName,
    Email,
    Phone,
    RandomText,
    EnumList,
    DateRange,
    TimestampNow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnGeneratorConfig {
    pub column: String,
    pub rule: DataGenRule,
    #[serde(default)]
    pub null_percent: u8,
    #[serde(default)]
    pub start: Option<i64>,
    #[serde(default)]
    pub step: Option<i64>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub values: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataGenOptions {
    pub schema: Option<String>,
    pub table: String,
    pub row_count: usize,
    #[serde(default)]
    pub truncate_first: bool,
    #[serde(default)]
    pub seed: Option<u64>,
    pub columns: Vec<ColumnGeneratorConfig>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DataGenPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DataGenReport {
    pub rows_inserted: u64,
    pub elapsed_ms: u64,
}

/// Compact deterministic SplitMix64 PRNG so preview and generation are fast,
/// reproducible when seeded, and require zero external crates.
struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed },
        }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn next_usize(&mut self, bound: usize) -> usize {
        if bound <= 1 {
            0
        } else {
            (self.next_u64() as usize) % bound
        }
    }

    fn next_i64_range(&mut self, min: i64, max: i64) -> i64 {
        let (lo, hi) = if min <= max { (min, max) } else { (max, min) };
        let span = (hi as i128 - lo as i128 + 1).max(1) as u64;
        lo.saturating_add((self.next_u64() % span) as i64)
    }

    fn next_f64_range(&mut self, min: f64, max: f64) -> f64 {
        let (lo, hi) = if min <= max { (min, max) } else { (max, min) };
        let unit = (self.next_u64() >> 11) as f64 / ((1u64 << 53) as f64);
        let raw = lo + unit * (hi - lo);
        (raw * 100.0).round() / 100.0
    }

    fn next_uuid_v4(&mut self) -> String {
        let a = self.next_u64();
        let b = self.next_u64();
        let time_low = (a >> 32) as u32;
        let time_mid = ((a >> 16) & 0xFFFF) as u16;
        let time_hi = ((a & 0x0FFF) as u16) | 0x4000;
        let clk_seq = (((b >> 48) & 0x3FFF) as u16) | 0x8000;
        let node = b & 0xFFFF_FFFF_FFFF;
        format!(
            "{time_low:08x}-{time_mid:04x}-{time_hi:04x}-{clk_seq:04x}-{node:012x}"
        )
    }
}

const FIRST_NAMES: &[&str] = &[
    "Alice", "Bob", "Carol", "David", "Emma", "Frank", "Grace", "Henry", "Iris", "Jack", "Kate",
    "Liam", "Mia", "Noah", "Olivia", "Paul", "Quinn", "Ruby", "Sam", "Tara",
];

const LAST_NAMES: &[&str] = &[
    "Smith", "Johnson", "Chen", "Wang", "Garcia", "Miller", "Davis", "Wilson", "Taylor", "Clark",
    "Lewis", "Walker", "Hall", "Young", "King", "Wright", "Lopez", "Hill", "Scott", "Green",
];

const EMAIL_DOMAINS: &[&str] = &[
    "example.com",
    "acme.dev",
    "corp.local",
    "mail.test",
    "studio.io",
];

const LOREM_WORDS: &[&str] = &[
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
    "kilo", "lima", "metro", "nova", "orbit", "pulse", "quantum", "ridge", "solar", "titan",
];

fn active_columns(cols: &[ColumnGeneratorConfig]) -> Vec<&ColumnGeneratorConfig> {
    cols.iter()
        .filter(|c| !c.column.trim().is_empty() && c.rule != DataGenRule::Skip)
        .collect()
}

fn generate_cell(cfg: &ColumnGeneratorConfig, row_idx: usize, rng: &mut SplitMix64) -> Value {
    if cfg.rule == DataGenRule::Null {
        return Value::Null;
    }
    if cfg.null_percent > 0 {
        let roll = (rng.next_u64() % 100) as u8;
        if roll < cfg.null_percent.min(100) {
            return Value::Null;
        }
    }
    match cfg.rule {
        DataGenRule::Skip | DataGenRule::Null => Value::Null,
        DataGenRule::Sequence => {
            let start = cfg.start.unwrap_or(1);
            let step = cfg.step.unwrap_or(1);
            json!(start.saturating_add((row_idx as i64).saturating_mul(step)))
        }
        DataGenRule::RandomInt => {
            let min = cfg.min.unwrap_or(1.0) as i64;
            let max = cfg.max.unwrap_or(1000.0) as i64;
            json!(rng.next_i64_range(min, max))
        }
        DataGenRule::RandomFloat => {
            let min = cfg.min.unwrap_or(1.0);
            let max = cfg.max.unwrap_or(1000.0);
            json!(rng.next_f64_range(min, max))
        }
        DataGenRule::Boolean => json!(rng.next_u64() & 1 == 0),
        DataGenRule::Uuid => json!(rng.next_uuid_v4()),
        DataGenRule::FullName => {
            let f = FIRST_NAMES[rng.next_usize(FIRST_NAMES.len())];
            let l = LAST_NAMES[rng.next_usize(LAST_NAMES.len())];
            json!(format!("{f} {l}"))
        }
        DataGenRule::Email => {
            let f = FIRST_NAMES[rng.next_usize(FIRST_NAMES.len())].to_ascii_lowercase();
            let l = LAST_NAMES[rng.next_usize(LAST_NAMES.len())].to_ascii_lowercase();
            let dom = EMAIL_DOMAINS[rng.next_usize(EMAIL_DOMAINS.len())];
            let suffix = (row_idx + 1) % 10_000;
            json!(format!("{f}.{l}{suffix}@{dom}"))
        }
        DataGenRule::Phone => {
            let area = rng.next_i64_range(200, 989);
            let mid = rng.next_i64_range(100, 999);
            let last = rng.next_i64_range(1000, 9999);
            json!(format!("+1-{area:03}-{mid:03}-{last:04}"))
        }
        DataGenRule::RandomText => {
            let w1 = LOREM_WORDS[rng.next_usize(LOREM_WORDS.len())];
            let w2 = LOREM_WORDS[rng.next_usize(LOREM_WORDS.len())];
            let w3 = LOREM_WORDS[rng.next_usize(LOREM_WORDS.len())];
            json!(format!("{w1} {w2} {w3}"))
        }
        DataGenRule::EnumList => {
            let items: Vec<&str> = cfg
                .values
                .as_deref()
                .unwrap_or("active,pending,archived")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            if items.is_empty() {
                Value::Null
            } else {
                json!(items[rng.next_usize(items.len())])
            }
        }
        DataGenRule::DateRange => {
            let year = rng.next_i64_range(2021, 2026);
            let month = rng.next_i64_range(1, 12);
            let day = rng.next_i64_range(1, 28);
            json!(format!("{year:04}-{month:02}-{day:02}"))
        }
        DataGenRule::TimestampNow => {
            let year = rng.next_i64_range(2024, 2026);
            let month = rng.next_i64_range(1, 12);
            let day = rng.next_i64_range(1, 28);
            let hour = rng.next_i64_range(0, 23);
            let min = rng.next_i64_range(0, 59);
            let sec = rng.next_i64_range(0, 59);
            json!(format!(
                "{year:04}-{month:02}-{day:02} {hour:02}:{min:02}:{sec:02}"
            ))
        }
    }
}

pub fn preview_generated_data(opts: &DataGenOptions, limit: usize) -> AppResult<DataGenPreview> {
    let active = active_columns(&opts.columns);
    if active.is_empty() {
        return Err(AppError::msg(
            "select at least one non-skipped column to generate",
        ));
    }
    let count = opts.row_count.min(limit.max(1)).min(50);
    let seed = opts.seed.unwrap_or(42);
    let mut rng = SplitMix64::new(seed);
    let mut rows = Vec::with_capacity(count);
    for row_idx in 0..count {
        let row: Vec<Value> = active
            .iter()
            .map(|c| generate_cell(c, row_idx, &mut rng))
            .collect();
        rows.push(row);
    }
    Ok(DataGenPreview {
        columns: active.iter().map(|c| c.column.clone()).collect(),
        rows,
    })
}

fn value_to_bind_opt(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "1".into() } else { "0".into() }),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn value_to_pg_bind_opt(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

pub async fn generate_table_data(
    pool: &DbPool,
    opts: &DataGenOptions,
) -> AppResult<DataGenReport> {
    if opts.row_count == 0 {
        return Err(AppError::msg("row_count must be greater than 0"));
    }
    if opts.row_count > MAX_GENERATE_ROWS {
        return Err(AppError::msg(format!(
            "row_count cannot exceed {MAX_GENERATE_ROWS}"
        )));
    }
    let active = active_columns(&opts.columns);
    if active.is_empty() {
        return Err(AppError::msg(
            "select at least one non-skipped column to generate",
        ));
    }

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
    let columns: Vec<String> = active.iter().map(|c| c.column.clone()).collect();
    let col_list = columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");

    let pg_types = match pool {
        DbPool::Postgres(p) => {
            Some(crate::db::data::pg_column_types(p, opts.schema.as_deref(), &opts.table).await?)
        }
        _ => None,
    };
    let pg_casts: Option<Vec<String>> = pg_types.as_ref().map(|m| {
        columns
            .iter()
            .map(|c| m.get(c).cloned().unwrap_or_default())
            .collect()
    });

    let rows_per_batch = (900 / columns.len()).clamp(1, 250);
    let seed = opts.seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(42)
    });
    let mut rng = SplitMix64::new(seed);
    let mut rows_inserted: u64 = 0;

    match pool {
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Test data generator"),
        DbPool::Sqlite(p) => {
            let mut tx = p.begin().await?;
            if opts.truncate_first {
                sqlx::query(&format!("DELETE FROM {}", target))
                    .execute(&mut *tx)
                    .await?;
            }
            let mut row_idx = 0usize;
            while row_idx < opts.row_count {
                let chunk = (opts.row_count - row_idx).min(rows_per_batch);
                let sql = multi_insert_sql(
                    &target,
                    &col_list,
                    columns.len(),
                    chunk,
                    driver,
                    None,
                );
                let mut q = sqlx::query(&sql);
                for _ in 0..chunk {
                    for cfg in &active {
                        let cell = generate_cell(cfg, row_idx, &mut rng);
                        q = q.bind(value_to_bind_opt(&cell));
                    }
                    row_idx += 1;
                }
                q.execute(&mut *tx).await?;
                rows_inserted += chunk as u64;
            }
            tx.commit().await?;
        }
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await?;
            if opts.truncate_first {
                sqlx::query(&format!("TRUNCATE TABLE {} RESTART IDENTITY CASCADE", target))
                    .execute(&mut *tx)
                    .await?;
            }
            let mut row_idx = 0usize;
            while row_idx < opts.row_count {
                let chunk = (opts.row_count - row_idx).min(rows_per_batch);
                let sql = multi_insert_sql(
                    &target,
                    &col_list,
                    columns.len(),
                    chunk,
                    driver,
                    pg_casts.as_deref(),
                );
                let mut q = sqlx::query(&sql);
                for _ in 0..chunk {
                    for cfg in &active {
                        let cell = generate_cell(cfg, row_idx, &mut rng);
                        q = q.bind(value_to_pg_bind_opt(&cell));
                    }
                    row_idx += 1;
                }
                q.execute(&mut *tx).await?;
                rows_inserted += chunk as u64;
            }
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            let mut tx = p.begin().await?;
            if opts.truncate_first {
                sqlx::query(&format!("DELETE FROM {}", target))
                    .execute(&mut *tx)
                    .await?;
            }
            let mut row_idx = 0usize;
            while row_idx < opts.row_count {
                let chunk = (opts.row_count - row_idx).min(rows_per_batch);
                let sql = multi_insert_sql(
                    &target,
                    &col_list,
                    columns.len(),
                    chunk,
                    driver,
                    None,
                );
                let mut q = sqlx::query(&sql);
                for _ in 0..chunk {
                    for cfg in &active {
                        let cell = generate_cell(cfg, row_idx, &mut rng);
                        q = q.bind(value_to_bind_opt(&cell));
                    }
                    row_idx += 1;
                }
                q.execute(&mut *tx).await?;
                rows_inserted += chunk as u64;
            }
            tx.commit().await?;
        }
    }

    Ok(DataGenReport {
        rows_inserted,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_generated_data_is_deterministic_with_seed_and_skips_ignored_columns() {
        let opts = DataGenOptions {
            schema: None,
            table: "users".into(),
            row_count: 10,
            truncate_first: false,
            seed: Some(12345),
            columns: vec![
                ColumnGeneratorConfig {
                    column: "id".into(),
                    rule: DataGenRule::Skip,
                    null_percent: 0,
                    start: None,
                    step: None,
                    min: None,
                    max: None,
                    values: None,
                },
                ColumnGeneratorConfig {
                    column: "seq".into(),
                    rule: DataGenRule::Sequence,
                    null_percent: 0,
                    start: Some(100),
                    step: Some(5),
                    min: None,
                    max: None,
                    values: None,
                },
                ColumnGeneratorConfig {
                    column: "email".into(),
                    rule: DataGenRule::Email,
                    null_percent: 0,
                    start: None,
                    step: None,
                    min: None,
                    max: None,
                    values: None,
                },
                ColumnGeneratorConfig {
                    column: "status".into(),
                    rule: DataGenRule::EnumList,
                    null_percent: 0,
                    start: None,
                    step: None,
                    min: None,
                    max: None,
                    values: Some("open,closed".into()),
                },
            ],
        };

        let p1 = preview_generated_data(&opts, 5).unwrap();
        let p2 = preview_generated_data(&opts, 5).unwrap();
        assert_eq!(p1.columns, vec!["seq", "email", "status"]);
        assert_eq!(p1.rows.len(), 5);
        assert_eq!(p1.rows, p2.rows);
        assert_eq!(p1.rows[0][0], json!(100));
        assert_eq!(p1.rows[1][0], json!(105));
    }
}
