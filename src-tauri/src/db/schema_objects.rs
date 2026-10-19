//! Read-only listing and on-demand definition lookup for non-table schema objects.

use crate::db::data::quote_ident;
use crate::db::meta::{mysql_show_str, row_string};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};
use sqlx::{Column, Row};

pub const MAX_SCHEMA_OBJECTS: usize = 500;
pub const MAX_SCHEMA_OBJECT_DEFINITION_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaObject {
    pub kind: String,
    pub name: String,
    pub schema: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub identity: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaObjectsResult {
    pub objects: Vec<SchemaObject>,
    pub truncated: bool,
}

fn make_object(
    kind: &str,
    name: String,
    schema: Option<String>,
    table: Option<String>,
    identity: Option<String>,
) -> SchemaObject {
    SchemaObject {
        kind: kind.into(),
        name,
        schema,
        table,
        identity,
    }
}

fn normalize(mut objects: Vec<SchemaObject>) -> SchemaObjectsResult {
    objects.sort_by(|a, b| {
        (&a.kind, &a.schema, &a.name, &a.table, &a.identity).cmp(&(
            &b.kind,
            &b.schema,
            &b.name,
            &b.table,
            &b.identity,
        ))
    });
    let truncated = objects.len() > MAX_SCHEMA_OBJECTS;
    objects.truncate(MAX_SCHEMA_OBJECTS);
    SchemaObjectsResult { objects, truncated }
}

pub async fn list(pool: &DbPool, schema: Option<&str>) -> AppResult<SchemaObjectsResult> {
    let mut objects = Vec::new();
    match pool {
        DbPool::Sqlite(p) => {
            if schema.is_some_and(|s| s != "main") {
                return Err(AppError::msg(
                    "SQLite schema objects are available only in the main database",
                ));
            }
            let rows = sqlx::query("SELECT name, tbl_name FROM sqlite_schema WHERE type='trigger' ORDER BY name LIMIT 501")
                .fetch_all(p).await?;
            for row in rows {
                objects.push(make_object(
                    "trigger",
                    row.try_get("name")?,
                    Some("main".into()),
                    row.try_get("tbl_name").ok(),
                    None,
                ));
            }
        }
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or("public");
            let routines = sqlx::query(
                "SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind, pg_get_function_identity_arguments(p.oid) AS identity \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace \
                 WHERE n.nspname=$1 AND p.prokind IN ('f','p') \
                 ORDER BY kind, p.proname, identity LIMIT 501",
            ).bind(schema).fetch_all(p).await?;
            for row in routines {
                objects.push(make_object(
                    &row.try_get::<String, _>("kind")?,
                    row.try_get("proname")?,
                    Some(row.try_get("nspname")?),
                    None,
                    Some(row.try_get("identity")?),
                ));
            }
            let triggers = sqlx::query(
                "SELECT n.nspname, t.tgname, c.relname AS table_name \
                 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid \
                 JOIN pg_namespace n ON n.oid=c.relnamespace \
                 WHERE NOT t.tgisinternal AND n.nspname=$1 \
                 ORDER BY t.tgname, c.relname LIMIT 501",
            )
            .bind(schema)
            .fetch_all(p)
            .await?;
            for row in triggers {
                objects.push(make_object(
                    "trigger",
                    row.try_get("tgname")?,
                    Some(row.try_get("nspname")?),
                    Some(row.try_get("table_name")?),
                    None,
                ));
            }
            let sequences = sqlx::query(
                "SELECT schemaname, sequencename FROM pg_sequences \
                 WHERE schemaname=$1 ORDER BY sequencename LIMIT 501",
            )
            .bind(schema)
            .fetch_all(p)
            .await?;
            for row in sequences {
                objects.push(make_object(
                    "sequence",
                    row.try_get("sequencename")?,
                    Some(row.try_get("schemaname")?),
                    None,
                    None,
                ));
            }
        }
        DbPool::Mysql(p) => {
            let schema = schema.unwrap_or("");
            let routines = sqlx::query(
                "SELECT CAST(ROUTINE_SCHEMA AS CHAR) AS object_schema, CAST(ROUTINE_NAME AS CHAR) AS object_name, CAST(ROUTINE_TYPE AS CHAR) AS object_kind \
                 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=COALESCE(NULLIF(?,''),DATABASE()) \
                 ORDER BY ROUTINE_TYPE, ROUTINE_NAME LIMIT 501",
            ).bind(schema).fetch_all(p).await?;
            for row in routines {
                let kind: String = row.try_get("object_kind")?;
                objects.push(make_object(
                    &kind.to_ascii_lowercase(),
                    row_string(&row, "object_name").unwrap_or_default(),
                    row_string(&row, "object_schema"),
                    None,
                    None,
                ));
            }
            let triggers = sqlx::query(
                "SELECT CAST(TRIGGER_SCHEMA AS CHAR) AS object_schema, CAST(TRIGGER_NAME AS CHAR) AS object_name, CAST(EVENT_OBJECT_TABLE AS CHAR) AS table_name \
                 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=COALESCE(NULLIF(?,''),DATABASE()) \
                 ORDER BY TRIGGER_NAME LIMIT 501",
            ).bind(schema).fetch_all(p).await?;
            for row in triggers {
                objects.push(make_object(
                    "trigger",
                    row_string(&row, "object_name").unwrap_or_default(),
                    row_string(&row, "object_schema"),
                    row_string(&row, "table_name"),
                    None,
                ));
            }
            let events = sqlx::query(
                "SELECT CAST(EVENT_SCHEMA AS CHAR) AS object_schema, CAST(EVENT_NAME AS CHAR) AS object_name \
                 FROM information_schema.EVENTS WHERE EVENT_SCHEMA=COALESCE(NULLIF(?,''),DATABASE()) \
                 ORDER BY EVENT_NAME LIMIT 501",
            ).bind(schema).fetch_all(p).await?;
            for row in events {
                objects.push(make_object(
                    "event",
                    row_string(&row, "object_name").unwrap_or_default(),
                    row_string(&row, "object_schema"),
                    None,
                    None,
                ));
            }
        }
        DbPool::Redis(_) => {
            return Err(AppError::msg("schema objects are not supported for Redis"))
        }
    }
    Ok(normalize(objects))
}

fn required_schema(object: &SchemaObject) -> AppResult<&str> {
    object
        .schema
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg("schema object is missing its schema"))
}

pub async fn definition(pool: &DbPool, object: &SchemaObject) -> AppResult<String> {
    let definition = match (pool, object.kind.as_str()) {
        (DbPool::Sqlite(p), "trigger") => {
            if object
                .schema
                .as_deref()
                .is_some_and(|schema| schema != "main")
            {
                return Err(AppError::msg(
                    "SQLite trigger definitions are available only in the main database",
                ));
            }
            let row = sqlx::query(
                "SELECT CASE WHEN length(CAST(sql AS BLOB)) > ? THEN NULL ELSE sql END AS definition, \
                 length(CAST(sql AS BLOB)) AS definition_bytes FROM sqlite_schema \
                 WHERE type='trigger' AND name=? AND (? IS NULL OR tbl_name=?)",
            )
            .bind(MAX_SCHEMA_OBJECT_DEFINITION_BYTES as i64)
            .bind(&object.name)
            .bind(&object.table)
            .bind(&object.table)
            .fetch_optional(p)
            .await?;
            let row = row.ok_or_else(|| {
                AppError::msg("trigger no longer exists or its definition is unavailable")
            })?;
            let bytes: i64 = row.try_get("definition_bytes")?;
            ensure_definition_bytes(bytes)?;
            row.try_get::<Option<String>, _>("definition")?
                .ok_or_else(|| AppError::msg("trigger definition is unavailable"))
        }
        (DbPool::Postgres(p), "function" | "procedure") => {
            let schema = required_schema(object)?;
            let identity = object
                .identity
                .as_deref()
                .ok_or_else(|| AppError::msg("overload identity is required"))?;
            let row = sqlx::query(
                "WITH object_definition AS ( \
                   SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p \
                   JOIN pg_namespace n ON n.oid=p.pronamespace \
                   WHERE n.nspname=$1 AND p.proname=$2 AND pg_get_function_identity_arguments(p.oid)=$3 \
                     AND ((p.prokind='p' AND $4='procedure') OR (p.prokind='f' AND $4='function')) \
                 ) SELECT CASE WHEN octet_length(definition) > $5 THEN NULL ELSE definition END AS definition, \
                   octet_length(definition)::bigint AS definition_bytes FROM object_definition",
            )
            .bind(schema)
            .bind(&object.name)
            .bind(identity)
            .bind(&object.kind)
            .bind(MAX_SCHEMA_OBJECT_DEFINITION_BYTES as i64)
            .fetch_optional(p)
            .await?;
            let row = row.ok_or_else(|| {
                AppError::msg("routine no longer exists or its definition is unavailable")
            })?;
            let bytes: i64 = row.try_get("definition_bytes")?;
            ensure_definition_bytes(bytes)?;
            row.try_get::<Option<String>, _>("definition")?
                .ok_or_else(|| AppError::msg("routine definition is unavailable"))
        }
        (DbPool::Postgres(p), "trigger") => {
            let schema = required_schema(object)?;
            let table = object
                .table
                .as_deref()
                .ok_or_else(|| AppError::msg("trigger table is missing"))?;
            let row = sqlx::query(
                "WITH object_definition AS ( \
                   SELECT pg_get_triggerdef(t.oid, true) AS definition FROM pg_trigger t \
                   JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace \
                   WHERE NOT t.tgisinternal AND n.nspname=$1 AND c.relname=$2 AND t.tgname=$3 \
                 ) SELECT CASE WHEN octet_length(definition) > $4 THEN NULL ELSE definition END AS definition, \
                   octet_length(definition)::bigint AS definition_bytes FROM object_definition",
            )
            .bind(schema)
            .bind(table)
            .bind(&object.name)
            .bind(MAX_SCHEMA_OBJECT_DEFINITION_BYTES as i64)
            .fetch_optional(p)
            .await?;
            let row = row.ok_or_else(|| {
                AppError::msg("trigger no longer exists or its definition is unavailable")
            })?;
            let bytes: i64 = row.try_get("definition_bytes")?;
            ensure_definition_bytes(bytes)?;
            row.try_get::<Option<String>, _>("definition")?
                .ok_or_else(|| AppError::msg("trigger definition is unavailable"))
        }
        (DbPool::Postgres(p), "sequence") => {
            let schema = required_schema(object)?;
            let row = sqlx::query(
                "SELECT data_type::text AS data_type, start_value, min_value, max_value, increment_by, cache_size, cycle \
                 FROM pg_sequences WHERE schemaname=$1 AND sequencename=$2",
            ).bind(schema).bind(&object.name).fetch_optional(p).await?;
            let row = row.ok_or_else(|| {
                AppError::msg("sequence no longer exists or its definition is unavailable")
            })?;
            let data_type: String = row.try_get("data_type")?;
            let start: Option<i64> = row.try_get("start_value")?;
            let min: Option<i64> = row.try_get("min_value")?;
            let max: Option<i64> = row.try_get("max_value")?;
            let increment: Option<i64> = row.try_get("increment_by")?;
            let cache: Option<i64> = row.try_get("cache_size")?;
            let cycle: Option<bool> = row.try_get("cycle")?;
            Ok(format!(
                "CREATE SEQUENCE {}.{} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {} {}",
                quote_ident(DriverKind::Postgres, schema),
                quote_ident(DriverKind::Postgres, &object.name),
                data_type,
                increment.ok_or_else(|| AppError::msg("sequence increment is unavailable"))?,
                min.ok_or_else(|| AppError::msg("sequence minimum is unavailable"))?,
                max.ok_or_else(|| AppError::msg("sequence maximum is unavailable"))?,
                start.ok_or_else(|| AppError::msg("sequence start is unavailable"))?,
                cache.ok_or_else(|| AppError::msg("sequence cache is unavailable"))?,
                if cycle.unwrap_or(false) { "CYCLE" } else { "NO CYCLE" },
            ))
        }
        (DbPool::Mysql(p), "function" | "procedure" | "trigger" | "event") => {
            let schema = required_schema(object)?;
            let verb = match object.kind.as_str() {
                "function" => "FUNCTION",
                "procedure" => "PROCEDURE",
                "trigger" => "TRIGGER",
                "event" => "EVENT",
                _ => unreachable!(),
            };
            let sql = format!(
                "SHOW CREATE {verb} {}.{}",
                quote_ident(DriverKind::Mysql, schema),
                quote_ident(DriverKind::Mysql, &object.name)
            );
            let row = sqlx::raw_sql(&sql).fetch_one(p).await.map_err(|_| {
                AppError::msg("schema object no longer exists or its definition is unavailable")
            })?;
            let index = mysql_definition_column_index(
                &object.kind,
                row.columns().iter().map(|col| col.name()),
            )
            .ok_or_else(|| AppError::msg("database did not return a CREATE definition"))?;
            mysql_show_str(&row, row.columns()[index].name(), index)
                .ok_or_else(|| AppError::msg("schema object definition is unavailable"))
        }
        (DbPool::Redis(_), _) => Err(AppError::msg("schema objects are not supported for Redis")),
        _ => Err(AppError::msg(
            "unsupported schema object kind for this database",
        )),
    }?;
    enforce_definition_limit(definition)
}

fn enforce_definition_limit(definition: String) -> AppResult<String> {
    ensure_definition_bytes(definition.len() as i64)?;
    Ok(definition)
}

fn ensure_definition_bytes(bytes: i64) -> AppResult<()> {
    if bytes > MAX_SCHEMA_OBJECT_DEFINITION_BYTES as i64 {
        return Err(AppError::msg("schema object definition exceeds the 1 MiB editor limit; open a smaller object or inspect it with the database client"));
    }
    Ok(())
}

fn mysql_definition_column_index<'a>(
    kind: &str,
    mut columns: impl Iterator<Item = &'a str>,
) -> Option<usize> {
    if kind == "trigger" {
        columns.position(|name| name.eq_ignore_ascii_case("SQL Original Statement"))
    } else {
        columns.position(|name| name.starts_with("Create "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_limit_reports_truncation() {
        let objects = (0..=MAX_SCHEMA_OBJECTS)
            .map(|i| {
                make_object(
                    "trigger",
                    format!("t{i:03}"),
                    Some("main".into()),
                    None,
                    None,
                )
            })
            .collect();
        let result = normalize(objects);
        assert_eq!(result.objects.len(), MAX_SCHEMA_OBJECTS);
        assert!(result.truncated);
        assert_eq!(result.objects[0].name, "t000");
    }

    #[test]
    fn trigger_sort_order_includes_table_name() {
        let result = normalize(vec![
            make_object(
                "trigger",
                "same_name".into(),
                Some("public".into()),
                Some("z_table".into()),
                None,
            ),
            make_object(
                "trigger",
                "same_name".into(),
                Some("public".into()),
                Some("a_table".into()),
                None,
            ),
        ]);
        assert_eq!(result.objects[0].table.as_deref(), Some("a_table"));
        assert_eq!(result.objects[1].table.as_deref(), Some("z_table"));
    }

    #[test]
    fn mysql_definition_column_handles_trigger_metadata_name() {
        let trigger = ["Trigger", "sql_mode", "SQL Original Statement"];
        assert_eq!(
            mysql_definition_column_index("trigger", trigger.into_iter()),
            Some(2)
        );
        let routine = ["Procedure", "sql_mode", "Create Procedure"];
        assert_eq!(
            mysql_definition_column_index("procedure", routine.into_iter()),
            Some(2)
        );
        let event = ["Event", "sql_mode", "Create Event"];
        assert_eq!(
            mysql_definition_column_index("event", event.into_iter()),
            Some(2)
        );
    }

    #[test]
    fn definitions_over_one_mib_fail_without_truncation() {
        let definition = "x".repeat(MAX_SCHEMA_OBJECT_DEFINITION_BYTES + 1);
        assert!(enforce_definition_limit(definition)
            .unwrap_err()
            .to_string()
            .contains("1 MiB"));
    }

    #[tokio::test]
    async fn sqlite_lists_and_reads_trigger_definition() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER \"trig\"\"ger\" AFTER INSERT ON parent BEGIN SELECT 1; END")
            .execute(&pool)
            .await
            .unwrap();
        let wrapped = DbPool::Sqlite(pool.clone());
        let listed = list(&wrapped, Some("main")).await.unwrap();
        assert!(!listed.truncated);
        assert_eq!(listed.objects.len(), 1);
        assert_eq!(listed.objects[0].name, "trig\"ger");
        assert_eq!(listed.objects[0].table.as_deref(), Some("parent"));
        let sql_definition = definition(&wrapped, &listed.objects[0]).await.unwrap();
        assert!(sql_definition.contains("CREATE TRIGGER"));
        assert!(sql_definition.contains("trig\"\"ger"));

        let padding = "x".repeat(MAX_SCHEMA_OBJECT_DEFINITION_BYTES + 1);
        let create_large = format!(
            "CREATE TRIGGER oversized AFTER INSERT ON parent BEGIN SELECT '{padding}'; END"
        );
        sqlx::query(&create_large).execute(&pool).await.unwrap();
        let stored_bytes: i64 = sqlx::query_scalar(
            "SELECT length(CAST(sql AS BLOB)) FROM sqlite_schema WHERE type='trigger' AND name='oversized'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(stored_bytes > MAX_SCHEMA_OBJECT_DEFINITION_BYTES as i64);
        let too_large = SchemaObject {
            kind: "trigger".into(),
            name: "oversized".into(),
            schema: Some("main".into()),
            table: Some("parent".into()),
            identity: None,
        };
        let error = definition(&wrapped, &too_large).await.unwrap_err();
        assert!(error.to_string().contains("1 MiB"));

        let mut wrong_schema = listed.objects[0].clone();
        wrong_schema.schema = Some("attached".into());
        assert!(definition(&wrapped, &wrong_schema).await.is_err());
        let missing = SchemaObject {
            kind: "trigger".into(),
            name: "missing".into(),
            schema: Some("main".into()),
            table: Some("parent".into()),
            identity: None,
        };
        assert!(definition(&wrapped, &missing)
            .await
            .unwrap_err()
            .to_string()
            .contains("no longer exists"));
        pool.close().await;
    }
}
