//! Named SQL parameters are rewritten to native placeholders, never literals.
use crate::db::{
    exec,
    pool::DbPool,
    sessions::{self, EditorConnection},
};
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ParameterKind {
    Text,
    Integer,
    Decimal,
    Float,
    Boolean,
    Date,
    Datetime,
    Json,
    Binary,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct QueryParameter {
    pub name: String,
    pub kind: ParameterKind,
    /// None is SQL NULL; empty strings remain empty strings.
    pub value: Option<String>,
}

#[derive(Clone, Copy)]
pub struct Syntax {
    pub driver: DriverKind,
    pub backslash_strings: bool,
    pub ansi_quotes: bool,
    pub mysql_version: Option<(u32, bool)>,
}
impl Syntax {
    pub fn default_for(driver: DriverKind) -> Self {
        Self {
            driver,
            backslash_strings: driver == DriverKind::Mysql,
            ansi_quotes: false,
            mysql_version: None,
        }
    }
    pub fn from_setting(driver: DriverKind, setting: &str) -> Self {
        let mut syntax = Self::default_for(driver);
        match driver {
            DriverKind::Postgres => syntax.backslash_strings = setting.eq_ignore_ascii_case("off"),
            DriverKind::Mysql => {
                let (setting, version) = setting
                    .split_once(';')
                    .map_or((setting, None), |(mode, version)| (mode, Some(version)));
                syntax.mysql_version = version.and_then(|version| {
                    let mariadb = version.contains("MariaDB");
                    let version = version.strip_prefix("5.5.5-").unwrap_or(version);
                    let mut parts = version.split(['.', '-']);
                    Some((
                        parts.next()?.parse::<u32>().ok()? * 10000
                            + parts.next()?.parse::<u32>().ok()? * 100
                            + parts.next()?.parse::<u32>().ok()?,
                        mariadb,
                    ))
                });
                syntax.backslash_strings = !setting.split(',').any(|s| s == "NO_BACKSLASH_ESCAPES");
                syntax.ansi_quotes = setting.split(',').any(|s| s == "ANSI_QUOTES");
            }
            _ => {}
        }
        syntax
    }
}

pub fn driver_of(pool: &DbPool) -> DriverKind {
    match pool {
        DbPool::Sqlite(_) => DriverKind::Sqlite,
        DbPool::Postgres(_) => DriverKind::Postgres,
        DbPool::Mysql(_) => DriverKind::Mysql,
        DbPool::Redis(_) => DriverKind::Redis,
    }
}
pub fn setting_query(driver: DriverKind) -> Option<&'static str> {
    match driver {
        DriverKind::Postgres => Some("SELECT current_setting('standard_conforming_strings')"),
        DriverKind::Mysql => Some("SELECT CONCAT(@@SESSION.sql_mode, ';', VERSION())"),
        _ => None,
    }
}

struct Occurrence {
    start: usize,
    end: usize,
    name: String,
}
fn name_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}
fn name_char(c: u8) -> bool {
    name_start(c) || c.is_ascii_digit()
}

fn occurrences(sql: &str, syntax: Syntax) -> AppResult<Vec<Occurrence>> {
    let effective = crate::db::sql_script::mysql_effective_sql(sql, syntax)?;
    let sql = effective.as_ref();
    let bytes = sql.as_bytes();
    let mut found = Vec::new();
    let mut native = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'-'
            && bytes.get(i + 1) == Some(&b'-')
            && (syntax.driver != DriverKind::Mysql
                || bytes.get(i + 2).is_none_or(|c| c.is_ascii_whitespace()))
            || c == b'#' && syntax.driver == DriverKind::Mysql
        {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            let mut depth = 1;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'/'
                    && bytes.get(i + 1) == Some(&b'*')
                    && syntax.driver == DriverKind::Postgres
                {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if matches!(c, b'\'' | b'"' | b'`')
            || c == b'[' && syntax.driver == DriverKind::Sqlite
        {
            let end = if c == b'[' { b']' } else { c };
            let pg_escape = syntax.driver == DriverKind::Postgres
                && c == b'\''
                && i > 0
                && matches!(bytes[i - 1], b'e' | b'E')
                && (i < 2 || !name_char(bytes[i - 2]));
            let string = c == b'\''
                || c == b'"' && syntax.driver == DriverKind::Mysql && !syntax.ansi_quotes;
            let escapes = string && (syntax.backslash_strings || pg_escape);
            i += 1;
            while i < bytes.len() {
                if escapes && bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                } else if bytes[i] == end {
                    i += 1;
                    if bytes.get(i) == Some(&end) && end != b']' {
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if c == b'$' && syntax.driver == DriverKind::Postgres {
            let mut end = i + 1;
            if bytes.get(end).is_some_and(|c| name_start(*c) || *c >= 0x80) {
                while bytes.get(end).is_some_and(|c| name_char(*c) || *c >= 0x80) {
                    end += 1;
                }
            }
            if bytes.get(end) == Some(&b'$')
                && (i == 0
                    || !(name_char(bytes[i - 1]) || bytes[i - 1] >= 0x80 || bytes[i - 1] == b'$'))
            {
                let tag = &sql[i..=end];
                i = sql[end + 1..]
                    .find(tag)
                    .map_or(bytes.len(), |offset| end + 1 + offset + tag.len());
            } else {
                native |= bytes.get(i + 1).is_some_and(u8::is_ascii_digit)
                    && (i == 0
                        || !(name_char(bytes[i - 1])
                            || bytes[i - 1] >= 0x80
                            || bytes[i - 1] == b'$'));
                i += 1;
            }
        } else if c == b':' && bytes.get(i + 1) == Some(&b':') {
            i += 2; // PostgreSQL cast, not a named parameter.
        } else if c == b':' && bytes.get(i + 1).is_some_and(|c| name_start(*c)) {
            let start = i;
            i += 2;
            while bytes.get(i).is_some_and(|c| name_char(*c)) {
                i += 1;
            }
            found.push(Occurrence {
                start,
                end: i,
                name: sql[start + 1..i].to_owned(),
            });
        } else {
            native |= c == b'?' && syntax.driver != DriverKind::Postgres
                || matches!(c, b'@' | b'$')
                    && syntax.driver == DriverKind::Sqlite
                    && bytes.get(i + 1).is_some_and(|c| name_start(*c));
            i += 1;
        }
    }
    if native && !found.is_empty() {
        return Err(AppError::msg(
            "do not mix named parameters with native positional parameters",
        ));
    }
    if found.len() > 1024 {
        return Err(AppError::msg(
            "a statement may contain at most 1024 parameter references",
        ));
    }
    Ok(found)
}

/// Later statements can change quoting rules through SET, stored functions,
/// procedures or transaction rollback. Discover the union of possible names
/// before any write; execution still compiles with the actual session mode.
pub fn parameter_names(sqls: &[String], syntax: Syntax) -> AppResult<Vec<String>> {
    analyze_parameters(sqls, syntax, None)
}

pub(crate) fn validate_bindings(
    sqls: &[String],
    syntax: Syntax,
    parameters: &[QueryParameter],
) -> AppResult<()> {
    analyze_parameters(sqls, syntax, Some(parameters)).map(|_| ())
}

fn analyze_parameters(
    sqls: &[String],
    syntax: Syntax,
    parameters: Option<&[QueryParameter]>,
) -> AppResult<Vec<String>> {
    let sizes = parameters.map(|parameters| {
        parameters
            .iter()
            .map(|p| (p.name.as_str(), p.value.as_ref().map_or(0, String::len)))
            .collect::<HashMap<_, _>>()
    });
    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for (index, sql) in sqls.iter().enumerate() {
        let mut modes = vec![syntax];
        if index > 0 && syntax.driver != DriverKind::Sqlite {
            for backslash_strings in [false, true] {
                for ansi_quotes in [false, true] {
                    if syntax.driver == DriverKind::Postgres && ansi_quotes {
                        continue;
                    }
                    modes.push(Syntax {
                        backslash_strings,
                        ansi_quotes,
                        ..syntax
                    });
                }
            }
        }
        for mode in modes {
            let mut bound_bytes = 0;
            for occurrence in occurrences(sql, mode)? {
                if let Some(sizes) = &sizes {
                    bound_bytes += sizes.get(occurrence.name.as_str()).ok_or_else(|| {
                        AppError::msg(format!("missing parameter :{}", occurrence.name))
                    })?;
                    if bound_bytes > 8 * 1024 * 1024 {
                        return Err(AppError::msg(
                            "expanded parameter bindings exceed the 8 MiB per statement limit",
                        ));
                    }
                }
                if occurrence.name.len() > 128 {
                    return Err(AppError::msg(
                        "parameter names may contain at most 128 characters",
                    ));
                }
                if seen.insert(occurrence.name.clone()) {
                    names.push(occurrence.name);
                }
            }
        }
    }
    if names.len() > 128 {
        return Err(AppError::msg(
            "a script may contain at most 128 named parameters",
        ));
    }
    Ok(names)
}

pub fn validate_parameters(parameters: &[QueryParameter]) -> AppResult<()> {
    if parameters.len() > 128 {
        return Err(AppError::msg("at most 128 parameters are supported"));
    }
    let mut seen = HashSet::new();
    let mut bytes = 0;
    for parameter in parameters {
        if parameter.name.is_empty()
            || parameter.name.len() > 128
            || !name_start(parameter.name.as_bytes()[0])
            || !parameter.name.bytes().all(name_char)
            || !seen.insert(&parameter.name)
        {
            return Err(AppError::msg(
                "parameter names must be unique ASCII identifiers (at most 128 characters)",
            ));
        }
        let size = parameter.value.as_ref().map_or(0, String::len);
        bytes += size;
        if size > 1024 * 1024 || bytes > 8 * 1024 * 1024 {
            return Err(AppError::msg(
                "parameter values exceed the 1 MiB per value / 8 MiB total limit",
            ));
        }
    }
    Ok(())
}

enum BoundValue {
    Text(Option<String>),
    Integer(Option<i64>),
    Float(Option<f64>),
    Boolean(Option<bool>),
    Date(Option<chrono::NaiveDate>),
    Datetime(Option<chrono::NaiveDateTime>),
    Binary(Option<Vec<u8>>),
}
struct BoundStatement {
    sql: String,
    values: Vec<BoundValue>,
}

fn decimal_type(value: Option<&str>, driver: DriverKind) -> AppResult<String> {
    let value = value.unwrap_or("0");
    let raw = value.strip_prefix(['+', '-']).unwrap_or(value);
    let (whole, fraction) = raw.split_once('.').unwrap_or((raw, ""));
    if raw.is_empty()
        || whole.is_empty() && fraction.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || !fraction.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(AppError::msg(
            "decimal requires a base-10 number without an exponent",
        ));
    }
    if driver != DriverKind::Mysql {
        return Ok("NUMERIC".into());
    }
    let precision = (whole.trim_start_matches('0').len() + fraction.len()).max(1);
    if precision > 65 || fraction.len() > 30 {
        return Err(AppError::msg(
            "MySQL decimals support at most 65 digits and 30 fractional digits",
        ));
    }
    Ok(format!("DECIMAL({precision},{})", fraction.len()))
}

fn compile(sql: &str, syntax: Syntax, parameters: &[QueryParameter]) -> AppResult<BoundStatement> {
    validate_parameters(parameters)?;
    let map: HashMap<_, _> = parameters.iter().map(|p| (p.name.as_str(), p)).collect();
    let mut result = String::new();
    let mut values = Vec::new();
    let mut previous = 0;
    let mut bound_bytes = 0;
    for occurrence in occurrences(sql, syntax)? {
        let parameter = map
            .get(occurrence.name.as_str())
            .ok_or_else(|| AppError::msg(format!("missing parameter :{}", occurrence.name)))?;
        bound_bytes += parameter.value.as_ref().map_or(0, String::len);
        if bound_bytes > 8 * 1024 * 1024 {
            return Err(AppError::msg(
                "expanded parameter bindings exceed the 8 MiB per statement limit",
            ));
        }
        result.push_str(&sql[previous..occurrence.start]);
        let placeholder = if syntax.driver == DriverKind::Postgres {
            format!("${}", values.len() + 1)
        } else {
            "?".into()
        };
        let value = parameter.value.as_deref();
        let invalid = || AppError::msg(format!("invalid value for parameter :{}", parameter.name));
        let bound = match parameter.kind {
            ParameterKind::Text => BoundValue::Text(parameter.value.clone()),
            ParameterKind::Integer => BoundValue::Integer(
                value
                    .map(str::parse::<i64>)
                    .transpose()
                    .map_err(|_| invalid())?,
            ),
            ParameterKind::Float => {
                let parsed = value
                    .map(str::parse::<f64>)
                    .transpose()
                    .map_err(|_| invalid())?;
                if parsed.is_some_and(|value| !value.is_finite()) {
                    return Err(invalid());
                }
                BoundValue::Float(parsed)
            }
            ParameterKind::Boolean => BoundValue::Boolean(
                value
                    .map(str::parse::<bool>)
                    .transpose()
                    .map_err(|_| invalid())?,
            ),
            ParameterKind::Date => BoundValue::Date(
                value
                    .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d"))
                    .transpose()
                    .map_err(|_| invalid())?,
            ),
            ParameterKind::Datetime => BoundValue::Datetime(
                value
                    .map(|s| {
                        chrono::NaiveDateTime::parse_from_str(
                            &s.replace('T', " "),
                            "%Y-%m-%d %H:%M:%S%.f",
                        )
                    })
                    .transpose()
                    .map_err(|_| invalid())?,
            ),
            ParameterKind::Binary => BoundValue::Binary(
                value
                    .map(|s| {
                        let s = s.strip_prefix("0x").unwrap_or(s);
                        if s.len() % 2 != 0 || !s.bytes().all(|c| c.is_ascii_hexdigit()) {
                            return Err(invalid());
                        }
                        (0..s.len())
                            .step_by(2)
                            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| invalid()))
                            .collect::<AppResult<Vec<_>>>()
                    })
                    .transpose()?,
            ),
            ParameterKind::Decimal => {
                let kind = decimal_type(value, syntax.driver)?;
                result.push_str(&format!("CAST({placeholder} AS {kind})"));
                values.push(BoundValue::Text(parameter.value.clone()));
                previous = occurrence.end;
                continue;
            }
            ParameterKind::Json => {
                if let Some(value) = value {
                    serde_json::from_str::<serde_json::Value>(value).map_err(|_| invalid())?;
                }
                if syntax.driver == DriverKind::Postgres {
                    result.push_str(&format!("CAST({placeholder} AS JSONB)"));
                } else if syntax.driver == DriverKind::Mysql {
                    result.push_str(&format!("CAST({placeholder} AS JSON)"));
                } else {
                    result.push_str(&placeholder);
                }
                values.push(BoundValue::Text(parameter.value.clone()));
                previous = occurrence.end;
                continue;
            }
        };
        result.push_str(&placeholder);
        values.push(bound);
        previous = occurrence.end;
    }
    result.push_str(&sql[previous..]);
    Ok(BoundStatement {
        sql: result,
        values,
    })
}

pub fn validate_values(parameters: &[QueryParameter], driver: DriverKind) -> AppResult<()> {
    validate_parameters(parameters)?;
    for parameter in parameters {
        compile(
            &format!("SELECT :{}", parameter.name),
            Syntax::default_for(driver),
            parameters,
        )?;
    }
    Ok(())
}

macro_rules! bound_query {
    ($statement:expr) => {{
        let mut query = sqlx::query(&$statement.sql);
        for value in &$statement.values {
            query = match value {
                BoundValue::Text(v) => query.bind(v.as_deref()),
                BoundValue::Integer(v) => query.bind(*v),
                BoundValue::Float(v) => query.bind(*v),
                BoundValue::Boolean(v) => query.bind(*v),
                BoundValue::Date(v) => query.bind(*v),
                BoundValue::Datetime(v) => query.bind(*v),
                BoundValue::Binary(v) => query.bind(v.as_deref()),
            };
        }
        query
    }};
}
macro_rules! execute_bound {
    ($connection:expr, $statement:expr, $decode:ident, $returns_rows:expr) => {{
        let start = Instant::now();
        if $returns_rows {
            let (rows, truncated) =
                exec::fetch_capped(bound_query!($statement).fetch(&mut *$connection)).await?;
            let mut result = exec::$decode(rows, start);
            result.truncated = truncated;
            if result.columns.is_empty() {
                result.columns = exec::describe_columns(&mut *$connection, &$statement.sql).await;
            }
            Ok(result)
        } else {
            let affected = bound_query!($statement)
                .execute(&mut *$connection)
                .await?
                .rows_affected();
            Ok(exec::QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: Some(affected),
                elapsed_ms: start.elapsed().as_millis() as u64,
                truncated: false,
            })
        }
    }};
}

pub(crate) async fn inspect_syntax(connection: &mut EditorConnection) -> AppResult<Syntax> {
    let driver = match connection {
        EditorConnection::Sqlite(_) => DriverKind::Sqlite,
        EditorConnection::Postgres(_) => DriverKind::Postgres,
        EditorConnection::Mysql(_) => DriverKind::Mysql,
    };
    let syntax = if let Some(query) = setting_query(driver) {
        let result = sessions::one(connection, query).await?;
        let setting = result
            .rows
            .first()
            .and_then(|r| r.first())
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::msg("could not inspect SQL string mode"))?;
        Syntax::from_setting(driver, setting)
    } else {
        Syntax::default_for(driver)
    };
    Ok(syntax)
}

/// PostgreSQL rejects mode inspection while a user transaction is aborted.
/// Recovery commands contain no string literals; their syntax is independent
/// of standard_conforming_strings. Let ROLLBACK/COMMIT reach the server, then
/// inspect the restored mode before the next statement.
pub(crate) async fn inspect_statement_syntax(
    connection: &mut EditorConnection,
    source: &str,
) -> AppResult<Syntax> {
    if matches!(connection, EditorConnection::Postgres(_)) {
        let default = Syntax::default_for(DriverKind::Postgres);
        if let Ok(Some(statement)) = crate::db::sql_script::Cursor::default().next(source, default)
        {
            if matches!(
                exec::first_keyword(&source[statement.range]).as_str(),
                "ROLLBACK" | "COMMIT" | "END"
            ) {
                return Ok(default);
            }
        }
    }
    inspect_syntax(connection).await
}

pub(crate) async fn execute_on(
    connection: &mut EditorConnection,
    sql: &str,
    parameters: &[QueryParameter],
    readonly: bool,
    syntax: Syntax,
) -> AppResult<exec::QueryResult> {
    let statement = compile(sql, syntax, parameters)?;
    if readonly && syntax.driver == DriverKind::Mysql {
        crate::db::sql_script::check_mysql_readonly(&statement.sql, syntax)?;
    }
    let effective = crate::db::sql_script::mysql_effective_sql(&statement.sql, syntax)?;
    if readonly && !exec::is_readonly(&effective) {
        return Err(AppError::msg(
            "connection is read-only — write statements are blocked",
        ));
    }
    // Preserve text-protocol support for transaction/DDL statements with no binds.
    if statement.values.is_empty() {
        return sessions::one_classified(connection, sql, exec::returns_rows(&effective)).await;
    }
    match connection {
        EditorConnection::Sqlite(c) => {
            execute_bound!(c, statement, decode_sqlite, exec::returns_rows(&effective))
        }
        EditorConnection::Postgres(c) => execute_bound!(
            c,
            statement,
            decode_postgres,
            exec::returns_rows(&effective)
        ),
        EditorConnection::Mysql(c) => {
            execute_bound!(c, statement, decode_mysql, exec::returns_rows(&effective))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn names(sql: &str, syntax: Syntax) -> Vec<String> {
        parameter_names(&[sql.into()], syntax).unwrap()
    }
    fn param(name: &str, kind: ParameterKind, value: Option<&str>) -> QueryParameter {
        QueryParameter {
            name: name.into(),
            kind,
            value: value.map(str::to_owned),
        }
    }
    #[test]
    fn mysql_conditional_comments_keep_binding_offsets_and_server_version_rules() {
        let sql = "SELECT /*!80000 :active, */ '水', ':literal', /*!999999 :future, */ /*M!100100 :maria, */ :ordinary";
        let mysql = Syntax::from_setting(DriverKind::Mysql, ";8.4.2");
        assert_eq!(names(sql, mysql), ["active", "ordinary"]);
        let bound = compile(
            sql,
            mysql,
            &[
                param("active", ParameterKind::Text, Some("secret")),
                param("ordinary", ParameterKind::Integer, Some("42")),
            ],
        )
        .unwrap();
        assert_eq!(
            bound.sql,
            "SELECT /*!80000 ?, */ '水', ':literal', /*!999999 :future, */ /*M!100100 :maria, */ ?"
        );
        assert_eq!(bound.values.len(), 2);
        let maria = Syntax::from_setting(DriverKind::Mysql, ";5.5.5-10.11.6-MariaDB");
        assert_eq!(names(sql, maria), ["maria", "ordinary"]);
        assert_eq!(names("SELECT /*!40101 :legacy, */ 1", maria), ["legacy"]);
    }
    #[test]
    fn postgres_quotes_comments_casts_and_repeated_names() {
        let sql = r#"SELECT :id::bigint, :id, ':hidden', E'escaped\':hidden', $$:hidden$$, $tag$:hidden$tag$, ":hidden" /* outer /* :hidden */ :hidden */ -- :hidden
        , :other"#;
        assert_eq!(
            names(sql, Syntax::default_for(DriverKind::Postgres)),
            ["id", "other"]
        );
        let statement = compile(
            "SELECT :id::bigint, :id",
            Syntax::default_for(DriverKind::Postgres),
            &[param(
                "id",
                ParameterKind::Integer,
                Some("9223372036854775807"),
            )],
        )
        .unwrap();
        assert_eq!(statement.sql, "SELECT $1::bigint, $2");
        assert_eq!(statement.values.len(), 2);
    }
    #[test]
    fn postgres_unicode_dollar_tags_and_dollar_in_identifiers() {
        assert_eq!(
            names(
                "SELECT $标签$:hidden$标签$, :actual",
                Syntax::default_for(DriverKind::Postgres)
            ),
            ["actual"]
        );
        assert_eq!(
            names(
                "SELECT column$1, :actual FROM saved",
                Syntax::default_for(DriverKind::Postgres)
            ),
            ["actual"]
        );
    }

    #[test]
    fn mysql_string_modes_and_comment_rules() {
        let sql = r#"SELECT 'a\' :escaped', :actual # :hidden
        , :last -- :hidden
        , 1--:subtract"#;
        assert_eq!(
            names(sql, Syntax::default_for(DriverKind::Mysql)),
            ["actual", "last", "subtract"]
        );
        let ambiguous = r#"SELECT 'a\' , :plain -- '
        , :last"#;
        assert_eq!(
            names(
                ambiguous,
                Syntax::from_setting(DriverKind::Mysql, "NO_BACKSLASH_ESCAPES")
            ),
            ["plain", "last"]
        );
        assert_eq!(
            names(ambiguous, Syntax::default_for(DriverKind::Mysql)),
            ["last"]
        );
        let quoted = r#"SELECT "a\", :visible -- ""#;
        assert_eq!(
            names(
                quoted,
                Syntax::from_setting(DriverKind::Mysql, "ANSI_QUOTES")
            ),
            ["visible"]
        );
        assert!(names(quoted, Syntax::default_for(DriverKind::Mysql)).is_empty());
    }
    #[test]
    fn sqlite_identifiers_and_native_placeholder_mixing() {
        assert_eq!(
            names(
                "SELECT [:hidden], `:hidden`, ':hidden', :actual",
                Syntax::default_for(DriverKind::Sqlite)
            ),
            ["actual"]
        );
        for (driver, sql) in [
            (DriverKind::Postgres, "SELECT :x, $1"),
            (DriverKind::Sqlite, "SELECT :x, ?1"),
            (DriverKind::Sqlite, "SELECT :x, @y"),
            (DriverKind::Mysql, "SELECT :x, ?"),
        ] {
            assert!(parameter_names(&[sql.into()], Syntax::default_for(driver)).is_err());
        }
        assert_eq!(
            names(
                "SELECT :document ? 'key'",
                Syntax::default_for(DriverKind::Postgres)
            ),
            ["document"]
        );
    }
    #[test]
    fn values_never_enter_compiled_sql() {
        let attack = "'; DROP TABLE users; -- 😃";
        let statement = compile(
            "SELECT :text, :null",
            Syntax::default_for(DriverKind::Sqlite),
            &[
                param("text", ParameterKind::Text, Some(attack)),
                param("null", ParameterKind::Text, None),
            ],
        )
        .unwrap();
        assert_eq!(statement.sql, "SELECT ?, ?");
        assert!(matches!(&statement.values[0], BoundValue::Text(Some(value)) if value == attack));
        assert!(matches!(&statement.values[1], BoundValue::Text(None)));
    }
    #[test]
    fn rejects_missing_invalid_duplicate_and_oversized_parameters() {
        assert!(compile(
            "SELECT :missing",
            Syntax::default_for(DriverKind::Sqlite),
            &[]
        )
        .is_err());
        for (kind, value) in [
            (ParameterKind::Integer, "9223372036854775808"),
            (ParameterKind::Float, "NaN"),
            (ParameterKind::Date, "2026-02-30"),
            (ParameterKind::Datetime, "2026-02-01 25:00:00"),
            (ParameterKind::Json, "{"),
            (ParameterKind::Binary, "abc"),
            (ParameterKind::Decimal, "1e10"),
        ] {
            assert!(
                validate_values(&[param("x", kind, Some(value))], DriverKind::Sqlite).is_err(),
                "accepted {value}"
            );
        }
        assert!(validate_parameters(&[
            param("x", ParameterKind::Text, None),
            param("x", ParameterKind::Integer, None)
        ])
        .is_err());
        assert!(validate_parameters(&[param("bad-name", ParameterKind::Text, None)]).is_err());
        assert!(validate_parameters(&[param(
            "x",
            ParameterKind::Text,
            Some(&"a".repeat(1024 * 1024 + 1))
        )])
        .is_err());
        let sql = vec![":x"; 1025].join(",");
        assert!(parameter_names(&[sql], Syntax::default_for(DriverKind::Sqlite)).is_err());
    }
    #[test]
    fn decimal_precision_and_json_casts() {
        let params = [
            param("d", ParameterKind::Decimal, Some("-0.00012")),
            param("j", ParameterKind::Json, Some("{\"n\":123}")),
        ];
        let statement = compile(
            "SELECT :d, :j",
            Syntax::default_for(DriverKind::Mysql),
            &params,
        )
        .unwrap();
        assert_eq!(
            statement.sql,
            "SELECT CAST(? AS DECIMAL(5,5)), CAST(? AS JSON)"
        );
        assert!(decimal_type(Some(&format!("0.{}", "1".repeat(31))), DriverKind::Mysql).is_err());
        assert!(decimal_type(Some(&"1".repeat(66)), DriverKind::Mysql).is_err());
    }
}
