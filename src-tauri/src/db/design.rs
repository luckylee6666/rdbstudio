use crate::db::data::quote_ident;
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::Serialize;
use sqlx::Row;

#[derive(Debug, Clone, Serialize)]
pub struct ColumnDetail {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
    pub ordinal_position: i32,
    pub char_max_length: Option<i64>,
    pub numeric_precision: Option<i64>,
    pub numeric_scale: Option<i64>,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: Option<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
    pub method: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableDescription {
    pub schema: Option<String>,
    pub name: String,
    pub comment: Option<String>,
    pub columns: Vec<ColumnDetail>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
    pub indexes: Vec<IndexInfo>,
    pub row_estimate: Option<i64>,
    pub size_bytes: Option<i64>,
}

pub async fn describe(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<TableDescription> {
    match pool {
        DbPool::Sqlite(p) => describe_sqlite(p, table).await,
        DbPool::Postgres(p) => describe_postgres(p, schema, table).await,
        DbPool::Mysql(p) => describe_mysql_in(p, schema, table).await,
        DbPool::Redis(_) => crate::db::redis_ops::unsupported("Describe table"),
    }
}

pub async fn ddl(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<String> {
    match pool {
        DbPool::Redis(_) => crate::db::redis_ops::unsupported("Show DDL"),
        DbPool::Sqlite(p) => {
            let sql: Option<String> = sqlx::query_scalar(
                "SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')",
            )
            .bind(table)
            .fetch_optional(p)
            .await?;
            sql.map(|s| format!("{};", s))
                .ok_or_else(|| AppError::msg("object not found"))
        }
        DbPool::Mysql(p) => {
            let qualified = match schema {
                Some(s) if !s.is_empty() => format!(
                    "`{}`.`{}`",
                    s.replace('`', "``"),
                    table.replace('`', "``")
                ),
                _ => format!("`{}`", table.replace('`', "``")),
            };
            let stmt = format!("SHOW CREATE TABLE {}", qualified);
            let row = sqlx::query(&stmt).fetch_one(p).await?;
            let ddl: String = row.try_get::<String, _>(1)?;
            Ok(format!("{};", ddl))
        }
        DbPool::Postgres(p) => synth_pg_ddl(p, schema, table).await,
    }
}

// ----- SQLite -----
async fn describe_sqlite(
    p: &sqlx::SqlitePool,
    table: &str,
) -> AppResult<TableDescription> {
    let quoted = quote_ident(DriverKind::Sqlite, table);
    let info = sqlx::query(&format!("PRAGMA table_info({})", quoted))
        .fetch_all(p)
        .await?;
    let columns: Vec<ColumnDetail> = info
        .iter()
        .map(|r| {
            let name: String = r.try_get("name").unwrap_or_default();
            let ty: String = r.try_get("type").unwrap_or_default();
            let notnull: i64 = r.try_get("notnull").unwrap_or(0);
            let dflt: Option<String> = r.try_get("dflt_value").ok().flatten();
            let pk: i64 = r.try_get("pk").unwrap_or(0);
            let cid: i64 = r.try_get("cid").unwrap_or(0);
            ColumnDetail {
                name,
                data_type: ty,
                nullable: notnull == 0,
                default: dflt,
                comment: None,
                ordinal_position: cid as i32,
                char_max_length: None,
                numeric_precision: None,
                numeric_scale: None,
                is_primary_key: pk > 0,
                is_auto_increment: false, // SQLite uses ROWID alias; not easily detectable
            }
        })
        .collect();
    let pk: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.clone())
        .collect();

    // foreign keys
    let fk_rows = sqlx::query(&format!("PRAGMA foreign_key_list({})", quoted))
        .fetch_all(p)
        .await?;
    let mut fks: Vec<ForeignKey> = Vec::new();
    for r in &fk_rows {
        let id: i64 = r.try_get("id").unwrap_or(0);
        let col: String = r.try_get("from").unwrap_or_default();
        let ref_tbl: String = r.try_get("table").unwrap_or_default();
        let ref_col: String = r.try_get("to").unwrap_or_default();
        let on_upd: Option<String> = r.try_get("on_update").ok();
        let on_del: Option<String> = r.try_get("on_delete").ok();
        if let Some(existing) = fks.iter_mut().find(|f| f.name == format!("fk_{}", id)) {
            existing.columns.push(col);
            existing.referenced_columns.push(ref_col);
        } else {
            fks.push(ForeignKey {
                name: format!("fk_{}", id),
                columns: vec![col],
                referenced_schema: None,
                referenced_table: ref_tbl,
                referenced_columns: vec![ref_col],
                on_update: on_upd,
                on_delete: on_del,
            });
        }
    }

    // indexes
    let idx_list = sqlx::query(&format!("PRAGMA index_list({})", quoted))
        .fetch_all(p)
        .await?;
    let mut indexes: Vec<IndexInfo> = Vec::new();
    for r in &idx_list {
        let name: String = r.try_get("name").unwrap_or_default();
        let unique: i64 = r.try_get("unique").unwrap_or(0);
        let origin: String = r.try_get("origin").unwrap_or_default();
        let info = sqlx::query(&format!(
            "PRAGMA index_info({})",
            quote_ident(DriverKind::Sqlite, &name)
        ))
        .fetch_all(p)
        .await?;
        let cols: Vec<String> = info
            .iter()
            .filter_map(|ir| ir.try_get::<String, _>("name").ok())
            .collect();
        indexes.push(IndexInfo {
            name,
            columns: cols,
            is_unique: unique == 1,
            is_primary: origin == "pk",
            method: None,
        });
    }

    Ok(TableDescription {
        schema: None,
        name: table.into(),
        comment: None,
        columns,
        primary_key: pk,
        foreign_keys: fks,
        indexes,
        row_estimate: None,
        size_bytes: None,
    })
}

// ----- Postgres -----
async fn describe_postgres(
    p: &sqlx::PgPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<TableDescription> {
    let schema = schema.unwrap_or("public").to_string();

    let col_rows = sqlx::query(
        "SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, \
                c.column_default, c.character_maximum_length, \
                c.numeric_precision, c.numeric_scale, c.ordinal_position, \
                pgd.description AS comment, \
                EXISTS ( \
                    SELECT 1 FROM information_schema.table_constraints tc \
                    JOIN information_schema.key_column_usage kcu \
                      ON tc.constraint_name = kcu.constraint_name \
                     AND tc.table_schema = kcu.table_schema \
                    WHERE tc.table_schema = c.table_schema \
                      AND tc.table_name = c.table_name \
                      AND tc.constraint_type = 'PRIMARY KEY' \
                      AND kcu.column_name = c.column_name \
                ) AS is_pk \
         FROM information_schema.columns c \
         LEFT JOIN pg_catalog.pg_statio_all_tables st \
           ON st.schemaname = c.table_schema AND st.relname = c.table_name \
         LEFT JOIN pg_catalog.pg_description pgd \
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(&schema)
    .bind(table)
    .fetch_all(p)
    .await?;

    let columns: Vec<ColumnDetail> = col_rows
        .iter()
        .map(|r| {
            let default: Option<String> = r.try_get("column_default").ok().flatten();
            let udt: String = r.try_get("udt_name").unwrap_or_default();
            let data_type: String = r.try_get("data_type").unwrap_or_default();
            let type_label = if data_type.eq_ignore_ascii_case("USER-DEFINED")
                || data_type.eq_ignore_ascii_case("ARRAY")
            {
                udt
            } else {
                data_type
            };
            ColumnDetail {
                name: r.try_get("column_name").unwrap_or_default(),
                data_type: type_label,
                nullable: r
                    .try_get::<String, _>("is_nullable")
                    .map(|s| s == "YES")
                    .unwrap_or(true),
                default: default.clone(),
                comment: r.try_get::<Option<String>, _>("comment").ok().flatten(),
                ordinal_position: r.try_get::<i32, _>("ordinal_position").unwrap_or(0),
                char_max_length: r
                    .try_get::<Option<i32>, _>("character_maximum_length")
                    .ok()
                    .flatten()
                    .map(|v| v as i64),
                numeric_precision: r
                    .try_get::<Option<i32>, _>("numeric_precision")
                    .ok()
                    .flatten()
                    .map(|v| v as i64),
                numeric_scale: r
                    .try_get::<Option<i32>, _>("numeric_scale")
                    .ok()
                    .flatten()
                    .map(|v| v as i64),
                is_primary_key: r.try_get::<bool, _>("is_pk").unwrap_or(false),
                is_auto_increment: default
                    .as_deref()
                    .map(|d| d.starts_with("nextval(") || d.contains("GENERATED"))
                    .unwrap_or(false),
            }
        })
        .collect();

    let pk: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.clone())
        .collect();

    // Foreign keys
    let fk_rows = sqlx::query(
        "SELECT tc.constraint_name, \
                array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols, \
                ccu.table_schema AS ref_schema, \
                ccu.table_name AS ref_table, \
                array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS ref_cols, \
                rc.update_rule, rc.delete_rule \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name \
          AND tc.table_schema = kcu.table_schema \
         JOIN information_schema.referential_constraints rc \
           ON tc.constraint_name = rc.constraint_name \
         JOIN information_schema.constraint_column_usage ccu \
           ON ccu.constraint_name = tc.constraint_name \
         WHERE tc.table_schema = $1 AND tc.table_name = $2 \
           AND tc.constraint_type = 'FOREIGN KEY' \
         GROUP BY tc.constraint_name, ccu.table_schema, ccu.table_name, rc.update_rule, rc.delete_rule",
    )
    .bind(&schema)
    .bind(table)
    .fetch_all(p)
    .await?;
    let fks: Vec<ForeignKey> = fk_rows
        .iter()
        .map(|r| ForeignKey {
            name: r.try_get("constraint_name").unwrap_or_default(),
            columns: r
                .try_get::<Vec<String>, _>("cols")
                .unwrap_or_default(),
            referenced_schema: r.try_get("ref_schema").ok(),
            referenced_table: r.try_get("ref_table").unwrap_or_default(),
            referenced_columns: r
                .try_get::<Vec<String>, _>("ref_cols")
                .unwrap_or_default(),
            on_update: r.try_get("update_rule").ok(),
            on_delete: r.try_get("delete_rule").ok(),
        })
        .collect();

    // Indexes
    let idx_rows = sqlx::query(
        "SELECT i.relname AS name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary, \
                am.amname AS method, \
                array_agg(a.attname ORDER BY array_position(ix.indkey::int[], a.attnum)) AS cols \
         FROM pg_class t \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_am am ON am.oid = i.relam \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         WHERE n.nspname = $1 AND t.relname = $2 \
         GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname \
         ORDER BY ix.indisprimary DESC, i.relname",
    )
    .bind(&schema)
    .bind(table)
    .fetch_all(p)
    .await?;
    let indexes: Vec<IndexInfo> = idx_rows
        .iter()
        .map(|r| IndexInfo {
            name: r.try_get("name").unwrap_or_default(),
            columns: r.try_get::<Vec<String>, _>("cols").unwrap_or_default(),
            is_unique: r.try_get::<bool, _>("is_unique").unwrap_or(false),
            is_primary: r.try_get::<bool, _>("is_primary").unwrap_or(false),
            method: r.try_get("method").ok(),
        })
        .collect();

    // Stats
    let stats = sqlx::query(
        "SELECT reltuples::bigint AS estimate, pg_total_relation_size(c.oid)::bigint AS size \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(&schema)
    .bind(table)
    .fetch_optional(p)
    .await?;
    let (row_estimate, size_bytes) = stats
        .map(|r| {
            (
                r.try_get::<i64, _>("estimate").ok(),
                r.try_get::<i64, _>("size").ok(),
            )
        })
        .unwrap_or((None, None));

    // Table comment
    let comment: Option<String> = sqlx::query_scalar(
        "SELECT obj_description(c.oid) FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(&schema)
    .bind(table)
    .fetch_optional(p)
    .await?
    .flatten();

    Ok(TableDescription {
        schema: Some(schema),
        name: table.into(),
        comment,
        columns,
        primary_key: pk,
        foreign_keys: fks,
        indexes,
        row_estimate,
        size_bytes,
    })
}

async fn synth_pg_ddl(
    p: &sqlx::PgPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<String> {
    let desc = describe_postgres(p, schema, table).await?;
    let qualified = match &desc.schema {
        Some(s) => format!(
            "{}.{}",
            quote_ident(DriverKind::Postgres, s),
            quote_ident(DriverKind::Postgres, &desc.name)
        ),
        None => quote_ident(DriverKind::Postgres, &desc.name),
    };
    let mut out = format!("CREATE TABLE {} (\n", qualified);
    let col_lines: Vec<String> = desc
        .columns
        .iter()
        .map(|c| {
            let mut parts = format!(
                "  {} {}",
                quote_ident(DriverKind::Postgres, &c.name),
                fmt_pg_type(c)
            );
            if !c.nullable {
                parts.push_str(" NOT NULL");
            }
            if let Some(d) = &c.default {
                parts.push_str(&format!(" DEFAULT {}", d));
            }
            parts
        })
        .collect();
    out.push_str(&col_lines.join(",\n"));
    if !desc.primary_key.is_empty() {
        let pk = desc
            .primary_key
            .iter()
            .map(|c| quote_ident(DriverKind::Postgres, c))
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!(",\n  PRIMARY KEY ({})", pk));
    }
    for fk in &desc.foreign_keys {
        let cols = fk
            .columns
            .iter()
            .map(|c| quote_ident(DriverKind::Postgres, c))
            .collect::<Vec<_>>()
            .join(", ");
        let rcols = fk
            .referenced_columns
            .iter()
            .map(|c| quote_ident(DriverKind::Postgres, c))
            .collect::<Vec<_>>()
            .join(", ");
        let rtbl = match &fk.referenced_schema {
            Some(s) => format!(
                "{}.{}",
                quote_ident(DriverKind::Postgres, s),
                quote_ident(DriverKind::Postgres, &fk.referenced_table)
            ),
            None => quote_ident(DriverKind::Postgres, &fk.referenced_table),
        };
        out.push_str(&format!(
            ",\n  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            quote_ident(DriverKind::Postgres, &fk.name),
            cols,
            rtbl,
            rcols
        ));
        if let Some(u) = &fk.on_update {
            out.push_str(&format!(" ON UPDATE {}", u));
        }
        if let Some(d) = &fk.on_delete {
            out.push_str(&format!(" ON DELETE {}", d));
        }
    }
    out.push_str("\n);");

    // Indexes (excluding primary key)
    for ix in desc.indexes.iter().filter(|i| !i.is_primary) {
        let cols = ix
            .columns
            .iter()
            .map(|c| quote_ident(DriverKind::Postgres, c))
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!(
            "\nCREATE {}INDEX {} ON {} USING {} ({});",
            if ix.is_unique { "UNIQUE " } else { "" },
            quote_ident(DriverKind::Postgres, &ix.name),
            qualified,
            ix.method.as_deref().unwrap_or("btree"),
            cols
        ));
    }
    Ok(out)
}

fn fmt_pg_type(c: &ColumnDetail) -> String {
    let t = c.data_type.to_lowercase();
    if let Some(len) = c.char_max_length {
        if t == "character varying" || t == "varchar" || t == "character" || t == "char" {
            return format!(
                "{}({})",
                if t.starts_with("character var") {
                    "varchar"
                } else {
                    &t
                },
                len
            );
        }
    }
    if (t == "numeric" || t == "decimal") && c.numeric_precision.is_some() {
        return match (c.numeric_precision, c.numeric_scale) {
            (Some(p), Some(s)) => format!("numeric({},{})", p, s),
            (Some(p), None) => format!("numeric({})", p),
            _ => "numeric".into(),
        };
    }
    t
}

// ----- MySQL -----
async fn describe_mysql_in(
    p: &sqlx::MySqlPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<TableDescription> {
    // Columns via SHOW FULL COLUMNS — ACL-reliable and independent of current database.
    let show_cols = match schema {
        Some(s) => format!(
            "SHOW FULL COLUMNS FROM `{}` FROM `{}`",
            table.replace('`', "``"),
            s.replace('`', "``")
        ),
        None => format!("SHOW FULL COLUMNS FROM `{}`", table.replace('`', "``")),
    };
    let col_rows = sqlx::query(&show_cols).fetch_all(p).await?;

    let columns: Vec<ColumnDetail> = col_rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let type_str: String = r
                .try_get::<String, _>("Type")
                .or_else(|_| r.try_get::<String, _>(1))
                .unwrap_or_default();
            let key: String = r
                .try_get::<String, _>("Key")
                .or_else(|_| r.try_get::<String, _>(4))
                .unwrap_or_default();
            let extra: String = r
                .try_get::<String, _>("Extra")
                .or_else(|_| r.try_get::<String, _>(6))
                .unwrap_or_default();
            let (char_max, num_prec, num_scale) = parse_mysql_type(&type_str);
            ColumnDetail {
                name: r
                    .try_get::<String, _>("Field")
                    .or_else(|_| r.try_get::<String, _>(0))
                    .unwrap_or_default(),
                data_type: type_str,
                nullable: r
                    .try_get::<String, _>("Null")
                    .or_else(|_| r.try_get::<String, _>(3))
                    .map(|s| s.eq_ignore_ascii_case("YES"))
                    .unwrap_or(true),
                default: r
                    .try_get::<Option<String>, _>("Default")
                    .or_else(|_| r.try_get::<Option<String>, _>(5))
                    .ok()
                    .flatten(),
                comment: r
                    .try_get::<Option<String>, _>("Comment")
                    .or_else(|_| r.try_get::<Option<String>, _>(8))
                    .ok()
                    .flatten()
                    .filter(|s| !s.is_empty()),
                ordinal_position: (i + 1) as i32,
                char_max_length: char_max,
                numeric_precision: num_prec,
                numeric_scale: num_scale,
                is_primary_key: key == "PRI",
                is_auto_increment: extra.to_lowercase().contains("auto_increment"),
            }
        })
        .collect();

    let pk: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.clone())
        .collect();

    // Indexes via SHOW INDEX FROM (reliable under ACL)
    let show_idx = match schema {
        Some(s) => format!(
            "SHOW INDEX FROM `{}` FROM `{}`",
            table.replace('`', "``"),
            s.replace('`', "``")
        ),
        None => format!("SHOW INDEX FROM `{}`", table.replace('`', "``")),
    };
    let idx_rows = sqlx::query(&show_idx).fetch_all(p).await?;
    let mut idx_map: Vec<IndexInfo> = Vec::new();
    for r in &idx_rows {
        // SHOW INDEX columns: Table, Non_unique, Key_name, Seq_in_index, Column_name,
        //                    Collation, Cardinality, Sub_part, Packed, Null,
        //                    Index_type, Comment, Index_comment, Visible, Expression
        let name: String = r.try_get::<String, _>("Key_name").unwrap_or_default();
        let non_unique: i64 = r.try_get::<i64, _>("Non_unique").unwrap_or(1);
        let method: String = r.try_get::<String, _>("Index_type").unwrap_or_default();
        let col: String = r.try_get::<String, _>("Column_name").unwrap_or_default();
        if let Some(ix) = idx_map.iter_mut().find(|i| i.name == name) {
            ix.columns.push(col);
        } else {
            idx_map.push(IndexInfo {
                name: name.clone(),
                columns: vec![col],
                is_unique: non_unique == 0,
                is_primary: name == "PRIMARY",
                method: Some(method),
            });
        }
    }

    // Foreign keys via information_schema (best-effort; may be empty under strict ACLs)
    let schema_filter = match schema {
        Some(_) => "kcu.table_schema = ?",
        None => "kcu.table_schema = database()",
    };
    let fk_sql = format!(
        "SELECT kcu.constraint_name, kcu.column_name, kcu.referenced_table_schema, \
                kcu.referenced_table_name, kcu.referenced_column_name, \
                rc.update_rule, rc.delete_rule \
         FROM information_schema.key_column_usage kcu \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_name = kcu.constraint_name \
          AND rc.constraint_schema = kcu.constraint_schema \
         WHERE {} AND kcu.table_name = ? \
           AND kcu.referenced_table_name IS NOT NULL \
         ORDER BY kcu.constraint_name, kcu.ordinal_position",
        schema_filter
    );
    let mut fk_q = sqlx::query(&fk_sql);
    if let Some(s) = schema {
        fk_q = fk_q.bind(s);
    }
    fk_q = fk_q.bind(table);
    let fk_rows = fk_q.fetch_all(p).await.unwrap_or_default();
    let mut fks: Vec<ForeignKey> = Vec::new();
    for r in &fk_rows {
        let cname: String = r
            .try_get("constraint_name")
            .or_else(|_| r.try_get("CONSTRAINT_NAME"))
            .unwrap_or_default();
        let col: String = r
            .try_get("column_name")
            .or_else(|_| r.try_get("COLUMN_NAME"))
            .unwrap_or_default();
        let ref_s: Option<String> = r
            .try_get("referenced_table_schema")
            .or_else(|_| r.try_get("REFERENCED_TABLE_SCHEMA"))
            .ok();
        let ref_t: String = r
            .try_get("referenced_table_name")
            .or_else(|_| r.try_get("REFERENCED_TABLE_NAME"))
            .unwrap_or_default();
        let ref_c: String = r
            .try_get("referenced_column_name")
            .or_else(|_| r.try_get("REFERENCED_COLUMN_NAME"))
            .unwrap_or_default();
        let upd: Option<String> = r
            .try_get("update_rule")
            .or_else(|_| r.try_get("UPDATE_RULE"))
            .ok();
        let del: Option<String> = r
            .try_get("delete_rule")
            .or_else(|_| r.try_get("DELETE_RULE"))
            .ok();
        if let Some(existing) = fks.iter_mut().find(|f| f.name == cname) {
            existing.columns.push(col);
            existing.referenced_columns.push(ref_c);
        } else {
            fks.push(ForeignKey {
                name: cname,
                columns: vec![col],
                referenced_schema: ref_s,
                referenced_table: ref_t,
                referenced_columns: vec![ref_c],
                on_update: upd,
                on_delete: del,
            });
        }
    }

    // Stats
    let stats_sql = match schema {
        Some(_) => {
            "SELECT table_rows, data_length + index_length AS total_size, table_comment \
             FROM information_schema.tables \
             WHERE table_schema = ? AND table_name = ?"
        }
        None => {
            "SELECT table_rows, data_length + index_length AS total_size, table_comment \
             FROM information_schema.tables \
             WHERE table_schema = database() AND table_name = ?"
        }
    };
    let mut stats_q = sqlx::query(stats_sql);
    if let Some(s) = schema {
        stats_q = stats_q.bind(s);
    }
    stats_q = stats_q.bind(table);
    let stats = stats_q.fetch_optional(p).await.ok().flatten();
    let (row_estimate, size_bytes, comment) = match stats {
        Some(r) => (
            r.try_get::<Option<i64>, _>("table_rows")
                .or_else(|_| r.try_get::<Option<i64>, _>("TABLE_ROWS"))
                .ok()
                .flatten(),
            r.try_get::<Option<i64>, _>("total_size").ok().flatten(),
            r.try_get::<Option<String>, _>("table_comment")
                .or_else(|_| r.try_get::<Option<String>, _>("TABLE_COMMENT"))
                .ok()
                .flatten()
                .filter(|s| !s.is_empty()),
        ),
        None => (None, None, None),
    };

    Ok(TableDescription {
        schema: schema.map(String::from),
        name: table.into(),
        comment,
        columns,
        primary_key: pk,
        foreign_keys: fks,
        indexes: idx_map,
        row_estimate,
        size_bytes,
    })
}

fn parse_mysql_type(t: &str) -> (Option<i64>, Option<i64>, Option<i64>) {
    // e.g. "varchar(255)" | "decimal(10,2)" | "int(11) unsigned"
    let lower = t.to_lowercase();
    let Some(open) = lower.find('(') else {
        return (None, None, None);
    };
    let Some(close) = lower[open..].find(')') else {
        return (None, None, None);
    };
    let inner = &lower[open + 1..open + close];
    let is_numeric = lower.starts_with("decimal")
        || lower.starts_with("numeric")
        || lower.starts_with("float")
        || lower.starts_with("double");
    if inner.contains(',') && is_numeric {
        let mut parts = inner.split(',');
        let p = parts.next().and_then(|s| s.trim().parse::<i64>().ok());
        let s = parts.next().and_then(|s| s.trim().parse::<i64>().ok());
        return (None, p, s);
    }
    let v: Option<i64> = inner.trim().parse().ok();
    if is_numeric {
        (None, v, None)
    } else {
        (v, None, None)
    }
}
