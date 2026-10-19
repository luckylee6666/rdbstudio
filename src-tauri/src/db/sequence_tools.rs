//! Safe PostgreSQL sequence metadata and lifecycle operations.

use crate::db::data::quote_ident;
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequenceOptions {
    pub schema: String,
    pub name: String,
    pub data_type: String,
    pub start: String,
    pub increment: String,
    pub min: String,
    pub max: String,
    pub cache: String,
    pub cycle: bool,
}

#[derive(Debug, Clone, Copy)]
struct NumericOptions {
    start: i64,
    increment: i64,
    min: i64,
    max: i64,
    cache: i64,
    restart: Option<i64>,
}

fn require_postgres(pool: &DbPool) -> AppResult<&sqlx::PgPool> {
    match pool {
        DbPool::Postgres(pool) => Ok(pool),
        _ => Err(AppError::msg("sequence management is supported only for PostgreSQL")),
    }
}

fn quoted_name(schema: &str, name: &str) -> AppResult<String> {
    if schema.trim().is_empty() || name.trim().is_empty() {
        return Err(AppError::msg("sequence schema and name are required"));
    }
    if [schema, name].iter().any(|value| value.len() > 63 || value.contains('\0')) {
        return Err(AppError::msg("sequence identifiers must be at most 63 UTF-8 bytes and must not contain NUL"));
    }
    Ok(format!(
        "{}.{}",
        quote_ident(DriverKind::Postgres, schema),
        quote_ident(DriverKind::Postgres, name)
    ))
}

fn parse_number(value: &str, field: &str) -> AppResult<i64> {
    value
        .parse::<i64>()
        .map_err(|_| AppError::msg(format!("sequence {field} must be a signed 64-bit integer")))
}

fn validate(options: &SequenceOptions, restart: Option<&str>) -> AppResult<(String, NumericOptions)> {
    quoted_name(&options.schema, &options.name)?;
    let data_type = match options.data_type.trim().to_ascii_lowercase().as_str() {
        "smallint" => "smallint",
        "integer" => "integer",
        "bigint" => "bigint",
        _ => return Err(AppError::msg("sequence data type must be smallint, integer, or bigint")),
    };
    let (type_min, type_max) = match data_type {
        "smallint" => (i16::MIN as i64, i16::MAX as i64),
        "integer" => (i32::MIN as i64, i32::MAX as i64),
        _ => (i64::MIN, i64::MAX),
    };
    let numbers = NumericOptions {
        start: parse_number(&options.start, "start")?,
        increment: parse_number(&options.increment, "increment")?,
        min: parse_number(&options.min, "minimum")?,
        max: parse_number(&options.max, "maximum")?,
        cache: parse_number(&options.cache, "cache")?,
        restart: restart.map(|value| parse_number(value, "restart")).transpose()?,
    };
    if numbers.increment == 0 {
        return Err(AppError::msg("sequence increment must not be zero"));
    }
    if numbers.cache <= 0 {
        return Err(AppError::msg("sequence cache must be greater than zero"));
    }
    if numbers.min > numbers.max {
        return Err(AppError::msg("sequence minimum must not exceed maximum"));
    }
    if numbers.min < type_min || numbers.max > type_max {
        return Err(AppError::msg(format!("sequence bounds do not fit the {data_type} data type")));
    }
    if !(numbers.min..=numbers.max).contains(&numbers.start) {
        return Err(AppError::msg("sequence start must be within its minimum and maximum"));
    }
    if numbers.restart.is_some_and(|value| !(numbers.min..=numbers.max).contains(&value)) {
        return Err(AppError::msg("sequence restart value must be within its minimum and maximum"));
    }
    Ok((data_type.into(), numbers))
}

fn create_sql(options: &SequenceOptions, data_type: &str, n: NumericOptions) -> AppResult<String> {
    let name = quoted_name(&options.schema, &options.name)?;
    Ok(format!(
        "CREATE SEQUENCE {name} AS {data_type} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {} {}",
        n.increment,
        n.min,
        n.max,
        n.start,
        n.cache,
        if options.cycle { "CYCLE" } else { "NO CYCLE" },
    ))
}

fn alter_sql(options: &SequenceOptions, data_type: &str, n: NumericOptions) -> AppResult<String> {
    let name = quoted_name(&options.schema, &options.name)?;
    let restart = n.restart.map(|value| format!(" RESTART WITH {value}")).unwrap_or_default();
    Ok(format!(
        "ALTER SEQUENCE {name} AS {data_type} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {}{restart} CACHE {} {}",
        n.increment,
        n.min,
        n.max,
        n.start,
        n.cache,
        if options.cycle { "CYCLE" } else { "NO CYCLE" },
    ))
}

fn drop_sql(schema: &str, name: &str) -> AppResult<String> {
    Ok(format!("DROP SEQUENCE {} RESTRICT", quoted_name(schema, name)?))
}

pub async fn get_sequence_options(
    pool: &DbPool,
    schema: &str,
    name: &str,
) -> AppResult<SequenceOptions> {
    let pool = require_postgres(pool)?;
    if schema.trim().is_empty() || name.trim().is_empty() {
        return Err(AppError::msg("sequence schema and name are required"));
    }
    let row = sqlx::query(
        "SELECT schemaname, sequencename, data_type::text AS data_type, start_value, increment_by, min_value, max_value, cache_size, cycle \
         FROM pg_sequences WHERE schemaname=$1 AND sequencename=$2",
    )
    .bind(schema)
    .bind(name)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::msg("sequence does not exist or is not visible to this user"))?;
    let number = |field: &str| -> AppResult<String> {
        row.try_get::<Option<i64>, _>(field)?
            .map(|value| value.to_string())
            .ok_or_else(|| AppError::msg(format!("sequence {field} metadata is unavailable")))
    };
    Ok(SequenceOptions {
        schema: row.try_get("schemaname")?,
        name: row.try_get("sequencename")?,
        data_type: row.try_get("data_type")?,
        start: number("start_value")?,
        increment: number("increment_by")?,
        min: number("min_value")?,
        max: number("max_value")?,
        cache: number("cache_size")?,
        cycle: row.try_get("cycle")?,
    })
}

pub async fn save_sequence(
    pool: &DbPool,
    options: &SequenceOptions,
    create: bool,
    restart: Option<&str>,
) -> AppResult<SequenceOptions> {
    let pg = require_postgres(pool)?;
    let (data_type, numbers) = validate(options, restart)?;
    let mut tx = pg.begin().await?;
    if create {
        let sql = create_sql(options, &data_type, numbers)?;
        sqlx::query(&sql).execute(&mut *tx).await?;
        if let Some(restart) = numbers.restart {
            let sql = format!(
                "ALTER SEQUENCE {} RESTART WITH {restart}",
                quoted_name(&options.schema, &options.name)?
            );
            sqlx::query(&sql).execute(&mut *tx).await?;
        }
    } else {
        let sql = alter_sql(options, &data_type, numbers)?;
        sqlx::query(&sql).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    get_sequence_options(pool, &options.schema, &options.name).await
}

pub async fn drop_sequence(pool: &DbPool, schema: &str, name: &str) -> AppResult<()> {
    let pg = require_postgres(pool)?;
    let sql = drop_sql(schema, name)?;
    sqlx::raw_sql(&sql).execute(pg).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SequenceOptions {
        SequenceOptions {
            schema: "odd\"schema".into(),
            name: "odd\"sequence".into(),
            data_type: "bigint".into(),
            start: "1".into(),
            increment: "1".into(),
            min: "-9223372036854775808".into(),
            max: "9223372036854775807".into(),
            cache: "1".into(),
            cycle: false,
        }
    }

    #[test]
    fn create_and_alter_quote_names_and_do_not_restart_unless_requested() {
        let options = sample();
        let (data_type, numbers) = validate(&options, None).unwrap();
        let create = create_sql(&options, &data_type, numbers).unwrap();
        assert!(create.starts_with("CREATE SEQUENCE \"odd\"\"schema\".\"odd\"\"sequence\" AS bigint"));
        let alter = alter_sql(&options, &data_type, numbers).unwrap();
        assert!(alter.starts_with("ALTER SEQUENCE \"odd\"\"schema\".\"odd\"\"sequence\" AS bigint"));
        assert!(!alter.contains("RESTART"));
        let (_, numbers) = validate(&options, Some("42")).unwrap();
        assert!(alter_sql(&options, "bigint", numbers).unwrap().contains("RESTART WITH 42"));
        assert_eq!(drop_sql("odd\"schema", "odd\"sequence").unwrap(), "DROP SEQUENCE \"odd\"\"schema\".\"odd\"\"sequence\" RESTRICT");
        let json = serde_json::to_value(&options).unwrap();
        assert_eq!(json["start"], "1");
        assert_eq!(json["increment"], "1");
    }

    #[test]
    fn rejects_unsafe_types_and_invalid_ranges() {
        let mut options = sample();
        options.data_type = "bigint; DROP TABLE t".into();
        assert!(validate(&options, None).unwrap_err().to_string().contains("data type"));
        options = sample();
        options.increment = "0".into();
        assert!(validate(&options, None).unwrap_err().to_string().contains("increment"));
        options = sample();
        options.cache = "0".into();
        assert!(validate(&options, None).unwrap_err().to_string().contains("cache"));
        options = sample();
        options.data_type = "smallint".into();
        options.max = "32768".into();
        assert!(validate(&options, None).unwrap_err().to_string().contains("fit"));
        options = sample();
        options.start = "10".into();
        options.min = "20".into();
        assert!(validate(&options, None).unwrap_err().to_string().contains("start"));
        options = sample();
        assert!(validate(&options, Some("not a number")).unwrap_err().to_string().contains("restart"));
        options = sample();
        options.name = "名".repeat(22);
        assert!(validate(&options, None).unwrap_err().to_string().contains("63 UTF-8 bytes"));
        options.name = "name\0suffix".into();
        assert!(validate(&options, None).unwrap_err().to_string().contains("NUL"));
    }

    #[tokio::test]
    async fn postgres_sequence_options_preserve_current_value_and_drop_restricts_dependencies() {
        let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
            eprintln!("skip: RDBSTUDIO_TEST_PG_URL is not set");
            return;
        };
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(&url).await.unwrap();
        let wrapped = DbPool::Postgres(pool.clone());
        let schema: String = sqlx::query_scalar("SELECT current_schema()").fetch_one(&pool).await.unwrap();
        let name = format!("rdb_seq_{}", uuid::Uuid::new_v4().simple());
        let table = format!("rdb_seq_dep_{}", uuid::Uuid::new_v4().simple());
        let options = SequenceOptions {
            schema: schema.clone(),
            name: name.clone(),
            data_type: "bigint".into(),
            start: "20".into(),
            increment: "5".into(),
            min: "1".into(),
            max: "1000".into(),
            cache: "1".into(),
            cycle: false,
        };
        let live_result: AppResult<()> = async {
            let created = save_sequence(&wrapped, &options, true, None).await?;
            if created.start != "20" {
                return Err(AppError::msg("sequence start metadata did not round-trip"));
            }
            let qualified = format!("{}.{}", quote_ident(DriverKind::Postgres, &schema), quote_ident(DriverKind::Postgres, &name));
            let first: i64 = sqlx::query_scalar("SELECT nextval($1::regclass)::bigint").bind(&qualified).fetch_one(&pool).await?;
            let second: i64 = sqlx::query_scalar("SELECT nextval($1::regclass)::bigint").bind(&qualified).fetch_one(&pool).await?;
            if (first, second) != (20, 25) {
                return Err(AppError::msg("new sequence did not begin at its configured start"));
            }

            let mut updated = created;
            updated.start = "30".into();
            updated.increment = "10".into();
            updated.max = "2000".into();
            updated = save_sequence(&wrapped, &updated, false, None).await?;
            if updated.start != "30" {
                return Err(AppError::msg("ALTER SEQUENCE start metadata did not round-trip"));
            }
            let after_update: i64 = sqlx::query_scalar("SELECT nextval($1::regclass)::bigint").bind(&qualified).fetch_one(&pool).await?;
            if after_update != 35 {
                return Err(AppError::msg("ordinary ALTER reset the sequence current value"));
            }

            updated.start = "40".into();
            updated.increment = "3".into();
            let restarted = save_sequence(&wrapped, &updated, false, Some("80")).await?;
            if restarted.start != "40" {
                return Err(AppError::msg("restarted sequence start metadata did not round-trip"));
            }
            let after_restart: i64 = sqlx::query_scalar("SELECT nextval($1::regclass)::bigint").bind(&qualified).fetch_one(&pool).await?;
            if after_restart != 80 {
                return Err(AppError::msg("explicit sequence restart value was not applied"));
            }

            let table_sql = format!(
                "CREATE TABLE {} (id bigint DEFAULT nextval('{}'::regclass))",
                quote_ident(DriverKind::Postgres, &table),
                qualified.replace('\'', "''"),
            );
            sqlx::raw_sql(&table_sql).execute(&pool).await?;
            if drop_sequence(&wrapped, &schema, &name).await.is_ok() {
                return Err(AppError::msg("DROP SEQUENCE unexpectedly removed a referenced sequence"));
            }
            let table_exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2)",
            ).bind(&schema).bind(&table).fetch_one(&pool).await?;
            if !table_exists {
                return Err(AppError::msg("DROP SEQUENCE removed the dependent table"));
            }
            sqlx::raw_sql(&format!("DROP TABLE {}", quote_ident(DriverKind::Postgres, &table))).execute(&pool).await?;
            drop_sequence(&wrapped, &schema, &name).await?;
            Ok(())
        }
        .await;
        let _ = sqlx::raw_sql(&format!("DROP TABLE IF EXISTS {}", quote_ident(DriverKind::Postgres, &table))).execute(&pool).await;
        let _ = sqlx::raw_sql(&format!("DROP SEQUENCE IF EXISTS {} RESTRICT", quote_ident(DriverKind::Postgres, &name))).execute(&pool).await;
        pool.close().await;
        live_result.unwrap();
    }
}
