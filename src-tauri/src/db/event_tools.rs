//! Typed MySQL event inspection and maintenance.

use crate::db::data::quote_ident;
use crate::db::exec::{self, first_keyword};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use sqlx::{mysql::MySqlRow, MySqlConnection, MySqlPool, Row};

pub const MAX_EVENT_BODY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum EventIntervalUnit {
    Year,
    Quarter,
    Month,
    Week,
    Day,
    Hour,
    Minute,
    Second,
}

impl EventIntervalUnit {
    fn sql(self) -> &'static str {
        match self {
            Self::Year => "YEAR",
            Self::Quarter => "QUARTER",
            Self::Month => "MONTH",
            Self::Week => "WEEK",
            Self::Day => "DAY",
            Self::Hour => "HOUR",
            Self::Minute => "MINUTE",
            Self::Second => "SECOND",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value.to_ascii_uppercase().as_str() {
            "YEAR" => Ok(Self::Year),
            "QUARTER" => Ok(Self::Quarter),
            "MONTH" => Ok(Self::Month),
            "WEEK" => Ok(Self::Week),
            "DAY" => Ok(Self::Day),
            "HOUR" => Ok(Self::Hour),
            "MINUTE" => Ok(Self::Minute),
            "SECOND" => Ok(Self::Second),
            _ => Err(AppError::msg(format!(
                "unsupported MySQL event interval unit: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventSchedule {
    At {
        execute_at: String,
    },
    Every {
        interval_value: String,
        interval_unit: EventIntervalUnit,
        starts: Option<String>,
        ends: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventOptions {
    pub schema: String,
    pub name: String,
    pub schedule: EventSchedule,
    pub body: String,
    pub comment: String,
    /// MySQL ON COMPLETION PRESERVE behavior.
    pub preserve: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventDetails {
    pub options: EventOptions,
    pub enabled: bool,
    pub definer: String,
    pub time_zone: String,
    pub scheduler: String,
}

#[derive(Debug)]
struct ExistingEvent {
    definer: String,
    time_zone: String,
    sql_mode: String,
    body: String,
}

fn mysql_pool(pool: &DbPool) -> AppResult<&MySqlPool> {
    match pool {
        DbPool::Mysql(pool) => Ok(pool),
        _ => Err(AppError::msg(
            "MySQL events are only supported for MySQL connections",
        )),
    }
}

fn validate_name(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty() || value.chars().count() > 64 || value.contains('\0') {
        return Err(AppError::msg(format!("invalid event {label}")));
    }
    Ok(())
}

fn parse_datetime(value: &str, field: &str) -> AppResult<()> {
    let bytes = value.as_bytes();
    let exact_shape = bytes.len() == 19
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b' '
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit());
    if !exact_shape || chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").is_err() {
        return Err(AppError::msg(format!(
            "{field} must use YYYY-MM-DD HH:MM:SS"
        )));
    }
    Ok(())
}

fn validate_body(body: &str, allow_unchanged_complex: bool) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::msg("event body cannot be empty"));
    }
    if body.len() > MAX_EVENT_BODY_BYTES {
        return Err(AppError::msg("event body exceeds the 1 MiB limit"));
    }
    if body.contains('\0') {
        return Err(AppError::msg("event body contains a NUL byte"));
    }
    if allow_unchanged_complex {
        return Ok(());
    }
    if !exec::is_single_statement(body) || first_keyword(body) == "BEGIN" {
        return Err(AppError::msg(
            "event body must be one SQL statement; use CALL for complex logic",
        ));
    }
    Ok(())
}

fn validate_schedule(schedule: &EventSchedule) -> AppResult<()> {
    match schedule {
        EventSchedule::At { execute_at } => parse_datetime(execute_at, "execute_at"),
        EventSchedule::Every {
            interval_value,
            starts,
            ends,
            ..
        } => {
            if interval_value.is_empty()
                || !interval_value.bytes().all(|byte| byte.is_ascii_digit())
                || interval_value
                    .parse::<u64>()
                    .ok()
                    .filter(|value| *value > 0)
                    .is_none()
            {
                return Err(AppError::msg("event interval must be a positive integer"));
            }
            if let Some(starts) = starts {
                parse_datetime(starts, "starts")?;
            }
            if let Some(ends) = ends {
                parse_datetime(ends, "ends")?;
            }
            if let (Some(starts), Some(ends)) = (starts, ends) {
                if starts > ends {
                    return Err(AppError::msg("event ends must not precede starts"));
                }
            }
            Ok(())
        }
    }
}

fn validate_options(options: &EventOptions, allow_unchanged_complex: bool) -> AppResult<()> {
    validate_name(&options.schema, "schema")?;
    validate_name(&options.name, "name")?;
    validate_schedule(&options.schedule)?;
    validate_body(&options.body, allow_unchanged_complex)?;
    if options.comment.chars().count() > 64 || options.comment.contains('\0') {
        return Err(AppError::msg("event comment must be at most 64 characters"));
    }
    Ok(())
}

fn no_backslash_escapes(sql_mode: &str) -> bool {
    sql_mode
        .split(',')
        .any(|mode| mode.trim().eq_ignore_ascii_case("NO_BACKSLASH_ESCAPES"))
}

/// Quote a SQL string according to the session's SQL mode.
fn quote_value(value: &str, sql_mode: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    let backslash_escapes = !no_backslash_escapes(sql_mode);
    for ch in value.chars() {
        match ch {
            '\'' => out.push_str("''"),
            '\\' if backslash_escapes => out.push_str("\\\\"),
            '\0' if backslash_escapes => out.push_str("\\0"),
            '\n' if backslash_escapes => out.push_str("\\n"),
            '\r' if backslash_escapes => out.push_str("\\r"),
            '\t' if backslash_escapes => out.push_str("\\t"),
            '\u{001a}' if backslash_escapes => out.push_str("\\Z"),
            '\0' => unreachable!("NUL is rejected before quoting"),
            _ => out.push(ch),
        }
    }
    out.push('\'');
    out
}

fn quote_definer(definer: &str, sql_mode: &str) -> AppResult<String> {
    let mut parts = definer.split('@');
    let user = parts.next().unwrap_or_default();
    let host = parts.next().unwrap_or_default();
    if user.is_empty() || host.is_empty() || parts.next().is_some() {
        return Err(AppError::msg(
            "event definer contains multiple @ characters and cannot be safely preserved; use the SQL editor",
        ));
    }
    Ok(format!(
        "{}@{}",
        quote_value(user, sql_mode),
        quote_value(host, sql_mode)
    ))
}

fn schedule_sql(schedule: &EventSchedule, sql_mode: &str) -> String {
    match schedule {
        EventSchedule::At { execute_at } => {
            format!("ON SCHEDULE AT {}", quote_value(execute_at, sql_mode))
        }
        EventSchedule::Every {
            interval_value,
            interval_unit,
            starts,
            ends,
        } => {
            let mut sql = format!(
                "ON SCHEDULE EVERY {} {}",
                interval_value,
                interval_unit.sql()
            );
            if let Some(starts) = starts {
                sql.push_str(" STARTS ");
                sql.push_str(&quote_value(starts, sql_mode));
            }
            if let Some(ends) = ends {
                sql.push_str(" ENDS ");
                sql.push_str(&quote_value(ends, sql_mode));
            }
            sql
        }
    }
}

fn details_from_row(row: MySqlRow, scheduler: String) -> AppResult<EventDetails> {
    let kind: String = row.try_get("event_type")?;
    let schedule = if kind.eq_ignore_ascii_case("ONE TIME") {
        EventSchedule::At {
            execute_at: row
                .try_get::<Option<String>, _>("execute_at")?
                .ok_or_else(|| AppError::msg("event execution time is unavailable"))?,
        }
    } else if kind.eq_ignore_ascii_case("RECURRING") {
        EventSchedule::Every {
            interval_value: row
                .try_get::<Option<String>, _>("interval_value")?
                .ok_or_else(|| AppError::msg("event interval is unavailable"))?,
            interval_unit: EventIntervalUnit::parse(
                &row.try_get::<Option<String>, _>("interval_field")?
                    .ok_or_else(|| AppError::msg("event interval unit is unavailable"))?,
            )?,
            starts: row.try_get("starts_at")?,
            ends: row.try_get("ends_at")?,
        }
    } else {
        return Err(AppError::msg(format!(
            "unsupported MySQL event type: {kind}"
        )));
    };
    let status: String = row.try_get("event_status")?;
    let on_completion: String = row.try_get("on_completion")?;
    Ok(EventDetails {
        options: EventOptions {
            schema: row.try_get("event_schema")?,
            name: row.try_get("event_name")?,
            schedule,
            body: row
                .try_get::<Option<String>, _>("event_body")?
                .ok_or_else(|| AppError::msg("event body is unavailable"))?,
            comment: row.try_get("event_comment")?,
            preserve: on_completion.eq_ignore_ascii_case("PRESERVE"),
        },
        enabled: status.eq_ignore_ascii_case("ENABLED"),
        definer: row.try_get("definer")?,
        time_zone: row.try_get("time_zone")?,
        scheduler,
    })
}

async fn scheduler(conn: &mut MySqlConnection) -> AppResult<String> {
    Ok(sqlx::query_scalar("SELECT @@GLOBAL.event_scheduler")
        .fetch_one(&mut *conn)
        .await?)
}

const EVENT_SELECT: &str = "SELECT CAST(EVENT_SCHEMA AS CHAR) AS event_schema, CAST(EVENT_NAME AS CHAR) AS event_name, CAST(EVENT_TYPE AS CHAR) AS event_type, \
    CAST(DATE_FORMAT(EXECUTE_AT, '%Y-%m-%d %H:%i:%s') AS CHAR) AS execute_at, CAST(INTERVAL_VALUE AS CHAR) AS interval_value, \
    CAST(INTERVAL_FIELD AS CHAR) AS interval_field, CAST(DATE_FORMAT(STARTS, '%Y-%m-%d %H:%i:%s') AS CHAR) AS starts_at, \
    CAST(DATE_FORMAT(ENDS, '%Y-%m-%d %H:%i:%s') AS CHAR) AS ends_at, \
    CAST(CASE WHEN OCTET_LENGTH(EVENT_DEFINITION)>? THEN NULL ELSE EVENT_DEFINITION END AS CHAR) AS event_body, \
    OCTET_LENGTH(EVENT_DEFINITION) AS body_bytes, CAST(EVENT_COMMENT AS CHAR) AS event_comment, \
    CAST(STATUS AS CHAR) AS event_status, CAST(DEFINER AS CHAR) AS definer, CAST(TIME_ZONE AS CHAR) AS time_zone, CAST(ON_COMPLETION AS CHAR) AS on_completion \
    FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? AND EVENT_NAME=?";

pub async fn get_event_options(pool: &DbPool, schema: &str, name: &str) -> AppResult<EventDetails> {
    let pool = mysql_pool(pool)?;
    validate_name(schema, "schema")?;
    validate_name(name, "name")?;
    let mut conn = pool.acquire().await?;
    let row = sqlx::query(EVENT_SELECT)
        .bind(MAX_EVENT_BODY_BYTES as u64)
        .bind(schema)
        .bind(name)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| AppError::msg("event no longer exists"))?;
    let body_len: Option<i64> = row.try_get("body_bytes")?;
    if body_len.is_some_and(|bytes| bytes > MAX_EVENT_BODY_BYTES as i64) {
        return Err(AppError::msg("event body exceeds the 1 MiB editor limit"));
    }
    let scheduler = scheduler(&mut conn).await?;
    details_from_row(row, scheduler)
}

async fn read_existing(
    conn: &mut MySqlConnection,
    schema: &str,
    name: &str,
) -> AppResult<ExistingEvent> {
    let row = sqlx::query(
        "SELECT CAST(DEFINER AS CHAR) AS definer, CAST(TIME_ZONE AS CHAR) AS time_zone, CAST(SQL_MODE AS CHAR) AS sql_mode, \
         CAST(CASE WHEN OCTET_LENGTH(EVENT_DEFINITION)>? THEN NULL ELSE EVENT_DEFINITION END AS CHAR) AS event_body, \
         OCTET_LENGTH(EVENT_DEFINITION) AS body_bytes, ON_COMPLETION AS on_completion \
         FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? AND EVENT_NAME=?",
    )
    .bind(MAX_EVENT_BODY_BYTES as u64)
    .bind(schema)
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::msg("event no longer exists"))?;
    let body_len: Option<i64> = row.try_get("body_bytes")?;
    if body_len.is_some_and(|bytes| bytes > MAX_EVENT_BODY_BYTES as i64) {
        return Err(AppError::msg("event body exceeds the 1 MiB editor limit"));
    }
    let body: String = row
        .try_get::<Option<String>, _>("event_body")?
        .ok_or_else(|| AppError::msg("event body is unavailable"))?;
    Ok(ExistingEvent {
        definer: row.try_get("definer")?,
        time_zone: row.try_get("time_zone")?,
        sql_mode: row.try_get("sql_mode")?,
        body,
    })
}

async fn session_sql_mode(conn: &mut MySqlConnection) -> AppResult<String> {
    Ok(sqlx::query_scalar("SELECT @@SESSION.sql_mode")
        .fetch_one(&mut *conn)
        .await?)
}

async fn set_session_value(
    conn: &mut MySqlConnection,
    name: &str,
    value: &str,
    sql_mode: &str,
) -> AppResult<()> {
    let statement = format!("SET SESSION {name} = {}", quote_value(value, sql_mode));
    sqlx::query(&statement).execute(&mut *conn).await?;
    Ok(())
}

fn build_create(options: &EventOptions, sql_mode: &str) -> String {
    format!(
        "CREATE EVENT {}.{} {} ON COMPLETION {} DISABLE COMMENT {} DO {}",
        quote_ident(DriverKind::Mysql, &options.schema),
        quote_ident(DriverKind::Mysql, &options.name),
        schedule_sql(&options.schedule, sql_mode),
        if options.preserve {
            "PRESERVE"
        } else {
            "NOT PRESERVE"
        },
        quote_value(&options.comment, sql_mode),
        options.body.trim()
    )
}

fn build_alter(
    options: &EventOptions,
    existing: &ExistingEvent,
    sql_mode: &str,
    body_changed: bool,
) -> AppResult<String> {
    let definer = quote_definer(&existing.definer, sql_mode)?;
    let mut sql = format!(
        "ALTER DEFINER = {} EVENT {}.{} {} ON COMPLETION {} COMMENT {}",
        definer,
        quote_ident(DriverKind::Mysql, &options.schema),
        quote_ident(DriverKind::Mysql, &options.name),
        schedule_sql(&options.schedule, sql_mode),
        if options.preserve {
            "PRESERVE"
        } else {
            "NOT PRESERVE"
        },
        quote_value(&options.comment, sql_mode),
    );
    if body_changed {
        sql.push_str(" DO ");
        sql.push_str(options.body.trim());
    }
    Ok(sql)
}

pub async fn save_event(pool: &DbPool, options: EventOptions, create: bool) -> AppResult<()> {
    let pool = mysql_pool(pool)?;
    validate_name(&options.schema, "schema")?;
    validate_name(&options.name, "name")?;
    let mut conn = pool.acquire().await?;
    conn.close_on_drop();
    let original_mode = session_sql_mode(&mut conn).await?;
    if create {
        validate_options(&options, false)?;
        let sql = build_create(&options, &original_mode);
        sqlx::query(&sql).execute(&mut *conn).await?;
        return Ok(());
    }
    let existing = read_existing(&mut conn, &options.schema, &options.name).await?;
    let body_changed = options.body != existing.body;
    validate_options(&options, !body_changed)?;
    // ALTER parses schedule values in the event's original time zone and uses
    // the event's stored SQL mode for its new body/comment literals.
    set_session_value(&mut conn, "time_zone", &existing.time_zone, &original_mode).await?;
    set_session_value(&mut conn, "sql_mode", &existing.sql_mode, &original_mode).await?;
    let sql = build_alter(&options, &existing, &existing.sql_mode, body_changed)?;
    sqlx::query(&sql).execute(&mut *conn).await?;
    Ok(())
}

pub async fn set_event_enabled(
    pool: &DbPool,
    schema: &str,
    name: &str,
    enabled: bool,
) -> AppResult<()> {
    let pool = mysql_pool(pool)?;
    validate_name(schema, "schema")?;
    validate_name(name, "name")?;
    let mut conn = pool.acquire().await?;
    conn.close_on_drop();
    let original_mode = session_sql_mode(&mut conn).await?;
    let existing = read_existing(&mut conn, schema, name).await?;
    let definer = quote_definer(&existing.definer, &existing.sql_mode)?;
    set_session_value(&mut conn, "time_zone", &existing.time_zone, &original_mode).await?;
    set_session_value(&mut conn, "sql_mode", &existing.sql_mode, &original_mode).await?;
    let sql = format!(
        "ALTER DEFINER = {} EVENT {}.{} {}",
        definer,
        quote_ident(DriverKind::Mysql, schema),
        quote_ident(DriverKind::Mysql, name),
        if enabled { "ENABLE" } else { "DISABLE" },
    );
    sqlx::query(&sql).execute(&mut *conn).await?;
    Ok(())
}

pub async fn drop_event(pool: &DbPool, schema: &str, name: &str) -> AppResult<()> {
    let pool = mysql_pool(pool)?;
    validate_name(schema, "schema")?;
    validate_name(name, "name")?;
    let sql = format!(
        "DROP EVENT {}.{}",
        quote_ident(DriverKind::Mysql, schema),
        quote_ident(DriverKind::Mysql, name)
    );
    sqlx::query(&sql).execute(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(body: &str, schedule: EventSchedule) -> EventOptions {
        EventOptions {
            schema: "app`db".into(),
            name: "nightly`job".into(),
            schedule,
            body: body.into(),
            comment: "owner's \\ note".into(),
            preserve: true,
        }
    }

    #[test]
    fn creates_disabled_one_time_event_with_quoted_names_and_values() {
        let opts = options(
            "CALL `refresh_cache`()",
            EventSchedule::At {
                execute_at: "2099-01-02 03:04:05".into(),
            },
        );
        let sql = build_create(&opts, "");
        assert!(sql.contains("`app``db`.`nightly``job`"));
        assert!(sql.contains("ON SCHEDULE AT '2099-01-02 03:04:05'"));
        assert!(sql.contains("DISABLE COMMENT 'owner''s \\\\ note' DO CALL"));
    }

    #[test]
    fn create_quote_respects_no_backslash_escapes_mode() {
        assert_eq!(quote_value("a\\b'c", ""), "'a\\\\b''c'");
        assert_eq!(quote_value("a\\b'c", "NO_BACKSLASH_ESCAPES"), "'a\\b''c'");
    }

    #[test]
    fn alter_preserves_definer_and_omits_unchanged_complex_body() {
        let opts = options(
            "BEGIN UPDATE t SET n=1; INSERT INTO t VALUES (2); END",
            EventSchedule::Every {
                interval_value: "2".into(),
                interval_unit: EventIntervalUnit::Hour,
                starts: Some("2099-01-02 03:04:05".into()),
                ends: None,
            },
        );
        let old = ExistingEvent {
            definer: "worker@localhost".into(),
            time_zone: "+00:00".into(),
            sql_mode: "".into(),
            body: opts.body.clone(),
        };
        let sql = build_alter(&opts, &old, "", false).unwrap();
        assert!(sql.contains("ALTER DEFINER = 'worker'@'localhost'"));
        assert!(sql.contains("ON SCHEDULE EVERY 2 HOUR STARTS '2099-01-02 03:04:05'"));
        assert!(!sql.contains(" DO "));
    }

    #[test]
    fn changed_compound_body_and_bad_schedules_are_rejected() {
        assert!(validate_body("BEGIN SELECT 1; END", false).is_err());
        assert!(validate_body("SELECT 1; SELECT 2", false).is_err());
        assert!(validate_schedule(&EventSchedule::At {
            execute_at: "2099-02-30 03:04:05".into(),
        })
        .is_err());
        assert!(validate_schedule(&EventSchedule::Every {
            interval_value: "0".into(),
            interval_unit: EventIntervalUnit::Day,
            starts: None,
            ends: None,
        })
        .is_err());
    }

    #[test]
    fn definer_with_multiple_at_signs_is_rejected() {
        assert!(quote_definer("user@realm@host", "").is_err());
    }

    #[test]
    fn interval_unit_uses_uppercase_ipc_values() {
        let value = serde_json::to_string(&EventSchedule::Every {
            interval_value: "2".into(),
            interval_unit: EventIntervalUnit::Hour,
            starts: None,
            ends: None,
        })
        .unwrap();
        assert_eq!(
            value,
            r#"{"kind":"every","interval_value":"2","interval_unit":"HOUR","starts":null,"ends":null}"#
        );
        let roundtrip: EventSchedule = serde_json::from_str(&value).unwrap();
        assert_eq!(
            roundtrip,
            EventSchedule::Every {
                interval_value: "2".into(),
                interval_unit: EventIntervalUnit::Hour,
                starts: None,
                ends: None,
            }
        );
    }
}
