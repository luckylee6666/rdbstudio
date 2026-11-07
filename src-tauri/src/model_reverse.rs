//! Read-only database -> offline relational model projection. No data rows,
//! generated DDL or model-store writes are executed by this module.
use crate::{
    db::{data::quote_ident, pool::DbPool},
    error::{AppError, AppResult},
    model::DriverKind,
    named_presets::PresetContent,
    offline_models::{Column, Content, Model, Position, Relation, Table, UniqueKey},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct SourceTable {
    pub schema: String,
    pub name: String,
}
#[derive(Clone, Serialize, PartialEq)]
pub struct Issue {
    pub code: String,
    pub object: String,
}
#[derive(Serialize)]
pub struct Preview {
    pub model: Model,
    pub warnings: Vec<Issue>,
    pub omitted_warnings: usize,
}
#[derive(Clone, Serialize, PartialEq)]
struct Field {
    name: String,
    ty: String,
    nullable: bool,
    pk: i64,
    comment: String,
}
#[derive(Clone, Serialize, PartialEq)]
struct Key {
    name: String,
    columns: Vec<String>,
}
#[derive(Clone, Serialize, PartialEq)]
struct Foreign {
    name: String,
    columns: Vec<String>,
    target: SourceTable,
    targets: Vec<String>,
    update: String,
    delete: String,
}
#[derive(Clone, Serialize, PartialEq)]
struct Source {
    table: SourceTable,
    comment: String,
    fields: Vec<Field>,
    keys: Vec<Key>,
    foreign: Vec<Foreign>,
    issues: Vec<Issue>,
}
fn fail(code: &str) -> AppError {
    AppError::msg(format!("model_reverse_{code}"))
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn notice(out: &mut Vec<Issue>, code: &str, object: impl Into<String>) {
    out.push(Issue {
        code: code.into(),
        object: object.into(),
    });
}
fn label(t: &SourceTable) -> String {
    format!("{}.{}", t.schema, t.name)
}
fn valid_name(s: &str) -> bool {
    !s.trim().is_empty()
        && s.encode_utf16().count() <= 128
        && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
pub fn validate_selection(tables: &[SourceTable]) -> AppResult<()> {
    if tables.is_empty() || tables.len() > 200 {
        return Err(fail("limit"));
    }
    let mut seen = HashSet::new();
    for t in tables {
        if !valid_name(&t.schema) || !valid_name(&t.name) || !seen.insert(t) {
            return Err(fail("invalid"));
        }
    }
    Ok(())
}
fn check_counts(s: &Source) -> AppResult<()> {
    if s.fields.is_empty() {
        return Err(fail("missing"));
    }
    if s.fields.len() > 256 || s.keys.len() > 64 || s.foreign.len() > 1000 {
        return Err(fail("limit"));
    }
    Ok(())
}

pub async fn inspect(pool: &DbPool, tables: &[SourceTable]) -> AppResult<Preview> {
    validate_selection(tables)?;
    let mut sources = Vec::with_capacity(tables.len());
    let mut source_bytes = 0usize;
    let mut field_count = 0usize;
    let dialect = match pool {
        DbPool::Sqlite(p) => {
            if tables.iter().any(|t| t.schema != "main") {
                return Err(fail("schema"));
            }
            let mut tx = p.begin().await?;
            for table in tables {
                let source = sqlite(&mut tx, table).await?;
                check_counts(&source)?;
                source_bytes += serde_json::to_vec(&source)?.len();
                field_count += source.fields.len();
                if source_bytes > 2 * 1024 * 1024 || field_count > 4096 {
                    return Err(fail("limit"));
                }
                sources.push(source);
            }
            tx.rollback().await?;
            "sqlite"
        }
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await?;
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                .execute(&mut *tx)
                .await?;
            sqlx::query("SET LOCAL search_path = pg_catalog")
                .execute(&mut *tx)
                .await?;
            for table in tables {
                let source = postgres(&mut tx, table).await?;
                check_counts(&source)?;
                source_bytes += serde_json::to_vec(&source)?.len();
                field_count += source.fields.len();
                if source_bytes > 2 * 1024 * 1024 || field_count > 4096 {
                    return Err(fail("limit"));
                }
                sources.push(source);
            }
            tx.rollback().await?;
            "postgres"
        }
        DbPool::Mysql(p) => {
            let mut tx = p.begin().await?;
            let mut definitions = Vec::new();
            for table in tables {
                definitions.push(mysql_definition(&mut tx, table).await?);
                let source = mysql(&mut tx, table).await?;
                check_counts(&source)?;
                source_bytes += serde_json::to_vec(&source)?.len();
                field_count += source.fields.len();
                if source_bytes > 2 * 1024 * 1024 || field_count > 4096 {
                    return Err(fail("limit"));
                }
                sources.push(source);
            }
            // MySQL catalog reads do not provide a cross-table DDL snapshot.
            // Recheck every selected definition; never return a known mixed view.
            for (table, before) in tables.iter().zip(definitions) {
                if before != mysql_definition(&mut tx, table).await? {
                    return Err(fail("changed"));
                }
            }
            tx.rollback().await?;
            "mysql"
        }
        DbPool::Redis(_) => return Err(fail("driver")),
    };
    project(dialect, sources)
}
fn project(dialect: &str, sources: Vec<Source>) -> AppResult<Preview> {
    let mut warnings = vec![];
    notice(&mut warnings, "coverage", "");
    if dialect == "mysql" {
        notice(&mut warnings, "mysql_snapshot", "");
    }
    let mut tables = Vec::new();
    let mut by_source = HashMap::new();
    for source in &sources {
        let mut primary: Vec<_> = source.fields.iter().filter(|c| c.pk > 0).collect();
        primary.sort_by_key(|c| c.pk);
        let columns: Vec<_> = source
            .fields
            .iter()
            .map(|c| Column {
                id: id(),
                name: c.name.clone(),
                r#type: if c.ty.is_empty() {
                    "BLOB".into()
                } else {
                    c.ty.clone()
                },
                nullable: c.nullable && c.pk == 0,
                primary_key: c.pk > 0,
                unique: false,
                comment: c.comment.clone(),
            })
            .collect();
        let column_id = |name: &str| {
            columns
                .iter()
                .find(|c| c.name == name)
                .map(|c| c.id.clone())
                .ok_or_else(|| fail("changed"))
        };
        let keys = source
            .keys
            .iter()
            .map(|k| {
                Ok(UniqueKey {
                    id: id(),
                    name: k.name.clone(),
                    columns: k
                        .columns
                        .iter()
                        .map(|c| column_id(c))
                        .collect::<AppResult<_>>()?,
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        let pk = primary
            .iter()
            .map(|c| column_id(&c.name))
            .collect::<AppResult<Vec<_>>>()?;
        by_source.insert(source.table.clone(), tables.len());
        tables.push(Table {
            id: id(),
            name: source.table.name.clone(),
            schema: source.table.schema.clone(),
            comment: source.comment.clone(),
            position: Position {
                x: (tables.len() % 4) as f64 * 320.,
                y: (tables.len() / 4) as f64 * 450.,
            },
            columns,
            primary_key: Some(pk),
            unique_keys: Some(keys),
        });
        warnings.extend(source.issues.clone());
        for c in &source.fields {
            if c.pk > 0 && c.nullable {
                notice(
                    &mut warnings,
                    "nullable_pk",
                    format!("{}.{}", label(&source.table), c.name),
                );
            }
            if c.ty.is_empty() {
                notice(
                    &mut warnings,
                    "empty_type",
                    format!("{}.{}", label(&source.table), c.name),
                );
            }
        }
    }
    let mut relations = Vec::new();
    for (i, source) in sources.iter().enumerate() {
        for fk in &source.foreign {
            let object = format!("{}.{}", label(&source.table), fk.name);
            let Some(&parent_index) = by_source.get(&fk.target) else {
                notice(&mut warnings, "external_fk", object);
                continue;
            };
            let child = &tables[i];
            let parent = &tables[parent_index];
            let from = fk
                .columns
                .iter()
                .map(|name| {
                    child
                        .columns
                        .iter()
                        .find(|c| c.name == *name)
                        .map(|c| c.id.clone())
                        .ok_or_else(|| fail("changed"))
                })
                .collect::<AppResult<Vec<_>>>()?;
            let target_names = if fk.targets.iter().all(String::is_empty) {
                sources[parent_index]
                    .fields
                    .iter()
                    .filter(|c| c.pk > 0)
                    .map(|c| (c.pk, c.name.clone()))
                    .collect::<Vec<_>>()
            } else {
                fk.targets
                    .iter()
                    .enumerate()
                    .map(|(i, n)| (i as i64, n.clone()))
                    .collect()
            };
            let mut target_names = target_names;
            target_names.sort_by_key(|v| v.0);
            let to = target_names
                .iter()
                .map(|(_, name)| {
                    parent
                        .columns
                        .iter()
                        .find(|c| c.name == *name)
                        .map(|c| c.id.clone())
                        .ok_or_else(|| fail("changed"))
                })
                .collect::<AppResult<Vec<_>>>()?;
            if from.is_empty() || from.len() != to.len() || from.len() > 16 {
                return Err(fail("reference"));
            }
            let same =
                |cols: &[String]| cols.len() == from.len() && cols.iter().all(|c| from.contains(c));
            let one = same(child.primary_key.as_deref().unwrap_or_default())
                || child
                    .unique_keys
                    .as_ref()
                    .is_some_and(|keys| keys.iter().any(|k| same(&k.columns)));
            let mut name = fk.name.clone();
            let mut suffix = 1;
            while child
                .unique_keys
                .as_ref()
                .is_some_and(|keys| keys.iter().any(|k| k.name.eq_ignore_ascii_case(&name)))
                || relations.iter().any(|r: &Relation| {
                    r.from_table == child.id && r.name.eq_ignore_ascii_case(&name)
                })
            {
                name = format!("relationship_{suffix}");
                suffix += 1;
            }
            if name != fk.name {
                notice(&mut warnings, "renamed_fk", object);
            }
            relations.push(Relation {
                id: id(),
                name,
                from_table: child.id.clone(),
                from_columns: from.clone(),
                to_table: parent.id.clone(),
                to_columns: to,
                cardinality: if one { "one-one" } else { "one-many" }.into(),
                identifying: from
                    .iter()
                    .all(|id| child.columns.iter().any(|c| c.id == *id && c.primary_key)),
                on_update: Some(fk.update.clone()),
                on_delete: Some(fk.delete.clone()),
            });
        }
    }
    let model = Model {
        version: 2,
        dialect: dialect.into(),
        tables,
        relations,
    };
    Content {
        model: model.clone(),
    }
    .validate()
    .map_err(|_| fail("unsupported"))?;
    let omitted_warnings = warnings.len().saturating_sub(1000);
    warnings.truncate(1000);
    Ok(Preview {
        model,
        warnings,
        omitted_warnings,
    })
}

async fn sqlite(c: &mut sqlx::SqliteConnection, table: &SourceTable) -> AppResult<Source> {
    let definition: String =
        sqlx::query_scalar("SELECT sql FROM main.sqlite_schema WHERE name=? AND type='table'")
            .bind(&table.name)
            .fetch_optional(&mut *c)
            .await?
            .ok_or_else(|| fail("missing"))?;
    let mut out = Source {
        table: table.clone(),
        comment: String::new(),
        fields: vec![],
        keys: vec![],
        foreign: vec![],
        issues: vec![],
    };
    let rows = sqlx::query("SELECT name,type,\"notnull\",dflt_value,pk,hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid LIMIT 257").bind(&table.name).fetch_all(&mut *c).await?;
    for r in rows {
        let name: String = r.try_get("name")?;
        if r.try_get::<i64, _>("hidden")? != 0 {
            notice(
                &mut out.issues,
                "generated",
                format!("{}.{}", label(table), name),
            );
        }
        if r.try_get::<Option<String>, _>("dflt_value")?.is_some() {
            notice(
                &mut out.issues,
                "default",
                format!("{}.{}", label(table), name),
            );
        }
        out.fields.push(Field {
            name,
            ty: r.try_get("type")?,
            nullable: r.try_get::<i64, _>("notnull")? == 0,
            pk: r.try_get("pk")?,
            comment: String::new(),
        });
    }
    // SQLite SQL retains options, checks, collations and named constraints that
    // PRAGMAs do not expose. Always report that boundary, including AUTOINCREMENT.
    if !definition.is_empty() {
        notice(&mut out.issues, "sqlite_definition", label(table));
    }
    let indexes = sqlx::query(
        "SELECT name,\"unique\",origin,partial FROM pragma_index_list(?, 'main') LIMIT 1002",
    )
    .bind(&table.name)
    .fetch_all(&mut *c)
    .await?;
    if indexes.len() > 1000 {
        return Err(fail("limit"));
    }
    let has_pk_index = indexes
        .iter()
        .any(|r| r.try_get::<String, _>("origin").is_ok_and(|s| s == "pk"));
    if !has_pk_index && out.fields.iter().filter(|f| f.pk > 0).count() == 1 {
        for f in &mut out.fields {
            if f.pk > 0 && f.ty.eq_ignore_ascii_case("INTEGER") {
                f.nullable = false;
            }
        }
    }
    for r in indexes {
        if r.try_get::<String, _>("origin")? == "pk" {
            continue;
        }
        let name: String = r.try_get("name")?;
        let cols = sqlx::query("SELECT name,cid,coll FROM pragma_index_xinfo(?, 'main') WHERE key=1 ORDER BY seqno LIMIT 257").bind(&name).fetch_all(&mut *c).await?;
        if r.try_get::<i64, _>("unique")? == 1
            && r.try_get::<i64, _>("partial")? == 0
            && cols.iter().all(|r| {
                r.try_get::<i64, _>("cid").is_ok_and(|n| n >= 0)
                    && r.try_get::<String, _>("coll").is_ok_and(|s| s == "BINARY")
            })
        {
            out.keys.push(Key {
                name,
                columns: cols
                    .iter()
                    .map(|r| r.try_get("name"))
                    .collect::<Result<_, _>>()?,
            });
        } else {
            notice(
                &mut out.issues,
                "index",
                format!("{}.{}", label(table), name),
            );
        }
    }
    let rows =
        sqlx::query("SELECT * FROM pragma_foreign_key_list(?, 'main') ORDER BY id,seq LIMIT 16001")
            .bind(&table.name)
            .fetch_all(&mut *c)
            .await?;
    if rows.len() > 16000 {
        return Err(fail("limit"));
    }
    for r in rows {
        let name = format!("fk_{}", r.try_get::<i64, _>("id")?);
        let from: String = r.try_get("from")?;
        let to: Option<String> = r.try_get("to")?;
        if let Some(f) = out.foreign.iter_mut().find(|f| f.name == name) {
            f.columns.push(from);
            f.targets.push(to.unwrap_or_default());
        } else {
            out.foreign.push(Foreign {
                name,
                columns: vec![from],
                target: SourceTable {
                    schema: "main".into(),
                    name: r.try_get("table")?,
                },
                targets: vec![to.unwrap_or_default()],
                update: r.try_get("on_update")?,
                delete: r.try_get("on_delete")?,
            });
        }
    }
    Ok(out)
}

async fn postgres(c: &mut sqlx::PgConnection, table: &SourceTable) -> AppResult<Source> {
    let row = sqlx::query("SELECT c.oid::bigint AS oid,obj_description(c.oid) AS comment,c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p')").bind(&table.schema).bind(&table.name).fetch_optional(&mut *c).await?.ok_or_else(|| fail("missing"))?;
    let oid: i64 = row.try_get("oid")?;
    let mut out = Source {
        table: table.clone(),
        comment: row
            .try_get::<Option<String>, _>("comment")?
            .unwrap_or_default(),
        fields: vec![],
        keys: vec![],
        foreign: vec![],
        issues: vec![],
    };
    let rows = sqlx::query("SELECT a.attname::text AS name,format_type(a.atttypid,a.atttypmod) AS ty,a.attnotnull,array_position(p.conkey,a.attnum)::bigint AS pk,col_description(a.attrelid,a.attnum) AS comment,a.atthasdef,a.attidentity::text AS identity FROM pg_attribute a LEFT JOIN pg_constraint p ON p.conrelid=a.attrelid AND p.contype='p' WHERE a.attrelid=$1::bigint::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 257").bind(oid).fetch_all(&mut *c).await?;
    for r in rows {
        let name: String = r.try_get("name")?;
        if r.try_get::<bool, _>("atthasdef")? || !r.try_get::<String, _>("identity")?.is_empty() {
            notice(
                &mut out.issues,
                "default",
                format!("{}.{}", label(table), name),
            );
        }
        out.fields.push(Field {
            name,
            ty: r.try_get("ty")?,
            nullable: !r.try_get::<bool, _>("attnotnull")?,
            pk: r.try_get::<Option<i64>, _>("pk")?.unwrap_or(0),
            comment: r
                .try_get::<Option<String>, _>("comment")?
                .unwrap_or_default(),
        });
    }
    let rows = sqlx::query("SELECT i.relname::text AS name,ix.indisunique,ix.indisprimary,ix.indisvalid,ix.indimmediate,ix.indpred IS NOT NULL AS partial,ix.indexprs IS NOT NULL AS expression,ix.indnatts<>ix.indnkeyatts AS included,EXISTS(SELECT 1 FROM unnest(ix.indclass) cl(oid) JOIN pg_opclass oc ON oc.oid=cl.oid WHERE NOT oc.opcdefault) AS custom_operator,COALESCE((to_jsonb(ix)->>'indnullsnotdistinct')::bool,false) AS nulls_equal,ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.num WHERE k.ord<=ix.indnkeyatts ORDER BY k.ord) AS columns FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid WHERE ix.indrelid=$1::bigint::oid ORDER BY i.relname LIMIT 1001").bind(oid).fetch_all(&mut *c).await?;
    if rows.len() > 1000 {
        return Err(fail("limit"));
    }
    for r in rows {
        if r.try_get::<bool, _>("indisprimary")? {
            continue;
        }
        let name: String = r.try_get("name")?;
        if r.try_get::<bool, _>("indisunique")?
            && r.try_get::<bool, _>("indisvalid")?
            && r.try_get::<bool, _>("indimmediate")?
            && !r.try_get::<bool, _>("partial")?
            && !r.try_get::<bool, _>("expression")?
            && !r.try_get::<bool, _>("nulls_equal")?
            && !r.try_get::<bool, _>("custom_operator")?
        {
            out.keys.push(Key {
                name: name.clone(),
                columns: r.try_get("columns")?,
            });
            if r.try_get::<bool, _>("included")? {
                notice(
                    &mut out.issues,
                    "index_options",
                    format!("{}.{}", label(table), name),
                );
            }
        } else {
            notice(
                &mut out.issues,
                "index",
                format!("{}.{}", label(table), name),
            );
        }
    }
    let rows = sqlx::query("SELECT con.conname::text AS name,con.contype::text AS kind,con.condeferrable,con.convalidated,con.confmatchtype::text AS matching,con.confupdtype::text AS updating,con.confdeltype::text AS deleting,pg_get_constraintdef(con.oid) AS definition,n.nspname::text AS schema,t.relname::text AS target,ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.num ORDER BY k.ord) AS targets FROM pg_constraint con LEFT JOIN pg_class t ON t.oid=con.confrelid LEFT JOIN pg_namespace n ON n.oid=t.relnamespace WHERE con.conrelid=$1::bigint::oid AND con.contype NOT IN ('p','u','n') ORDER BY con.conname LIMIT 1001").bind(oid).fetch_all(&mut *c).await?;
    if rows.len() > 1000 {
        return Err(fail("limit"));
    }
    for r in rows {
        let name: String = r.try_get("name")?;
        if r.try_get::<String, _>("kind")? != "f" {
            notice(
                &mut out.issues,
                "constraint",
                format!("{}.{}", label(table), name),
            );
            continue;
        }
        if r.try_get::<bool, _>("condeferrable")?
            || !r.try_get::<bool, _>("convalidated")?
            || r.try_get::<String, _>("matching")? != "s"
            || r.try_get::<String, _>("definition")?.contains("SET NULL (")
            || r.try_get::<String, _>("definition")?
                .contains("SET DEFAULT (")
        {
            notice(
                &mut out.issues,
                "fk_options",
                format!("{}.{}", label(table), name),
            );
        }
        out.foreign.push(Foreign {
            name,
            columns: r.try_get("columns")?,
            target: SourceTable {
                schema: r.try_get("schema")?,
                name: r.try_get("target")?,
            },
            targets: r.try_get("targets")?,
            update: pg_action(&r.try_get::<String, _>("updating")?)?.into(),
            delete: pg_action(&r.try_get::<String, _>("deleting")?)?.into(),
        });
    }
    notice(&mut out.issues, "table_options", label(table));
    Ok(out)
}
fn pg_action(code: &str) -> AppResult<&'static str> {
    match code {
        "a" => Ok("NO ACTION"),
        "r" => Ok("RESTRICT"),
        "c" => Ok("CASCADE"),
        "n" => Ok("SET NULL"),
        "d" => Ok("SET DEFAULT"),
        _ => Err(fail("unsupported")),
    }
}

async fn mysql_definition(c: &mut sqlx::MySqlConnection, table: &SourceTable) -> AppResult<String> {
    let sql = format!(
        "SHOW CREATE TABLE {}.{}",
        quote_ident(DriverKind::Mysql, &table.schema),
        quote_ident(DriverKind::Mysql, &table.name)
    );
    let row = sqlx::query(&sql).fetch_one(c).await?;
    // Prepared SHOW metadata can expose a different result-column name. The
    // documented second column still carries the definition; retain the
    // existing binary/string decoding fallback used by other SHOW collectors.
    crate::db::meta::mysql_show_str(&row, "Create Table", 1).ok_or_else(|| fail("missing"))
}
async fn mysql(c: &mut sqlx::MySqlConnection, table: &SourceTable) -> AppResult<Source> {
    let row = sqlx::query("SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND TABLE_TYPE='BASE TABLE'").bind(&table.schema).bind(&table.name).fetch_optional(&mut *c).await?.ok_or_else(|| fail("missing"))?;
    let mut out = Source {
        table: table.clone(),
        comment: crate::db::meta::row_string(&row, 0).ok_or_else(|| fail("unsupported"))?,
        fields: vec![],
        keys: vec![],
        foreign: vec![],
        issues: vec![],
    };
    let rows = sqlx::query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLUMN_COMMENT,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 257").bind(&table.schema).bind(&table.name).fetch_all(&mut *c).await?;
    for r in rows {
        let get = |name| crate::db::meta::row_string(&r, name).unwrap_or_default();
        let name = get("COLUMN_NAME");
        if crate::db::meta::row_string(&r, "COLUMN_DEFAULT").is_some() || !get("EXTRA").is_empty() {
            notice(
                &mut out.issues,
                "default",
                format!("{}.{}", label(table), name),
            );
        }
        if !get("GENERATION_EXPRESSION").is_empty() {
            notice(
                &mut out.issues,
                "generated",
                format!("{}.{}", label(table), name),
            );
        }
        out.fields.push(Field {
            name,
            ty: get("COLUMN_TYPE"),
            nullable: get("IS_NULLABLE") == "YES",
            pk: 0,
            comment: get("COLUMN_COMMENT"),
        });
    }
    let rows = sqlx::query("SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 16001").bind(&table.schema).bind(&table.name).fetch_all(&mut *c).await?;
    if rows.len() > 16000 {
        return Err(fail("limit"));
    }
    let mut groups: Vec<(String, bool, bool, Vec<String>)> = vec![];
    for r in rows {
        let get = |name| crate::db::meta::row_string(&r, name).unwrap_or_default();
        let name = get("INDEX_NAME");
        let col = get("COLUMN_NAME");
        let unique = r.try_get::<i64, _>("NON_UNIQUE")? == 0;
        let plain = !col.is_empty()
            && r.try_get::<Option<i64>, _>("SUB_PART")?.is_none()
            && get("INDEX_TYPE") == "BTREE";
        if let Some(group) = groups.iter_mut().find(|g| g.0 == name) {
            group.2 &= plain;
            group.3.push(col);
        } else {
            groups.push((name, unique, plain, vec![col]));
        }
    }
    for (name, unique, plain, columns) in groups {
        if name == "PRIMARY" {
            for (i, col) in columns.iter().enumerate() {
                out.fields
                    .iter_mut()
                    .find(|c| c.name == *col)
                    .ok_or_else(|| fail("changed"))?
                    .pk = i as i64 + 1;
            }
        } else if unique && plain {
            out.keys.push(Key { name, columns });
        } else {
            notice(
                &mut out.issues,
                "index",
                format!("{}.{}", label(table), name),
            );
        }
    }
    let rows = sqlx::query("SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION LIMIT 16001").bind(&table.schema).bind(&table.name).fetch_all(&mut *c).await?;
    if rows.len() > 16000 {
        return Err(fail("limit"));
    }
    for r in rows {
        let get = |name| crate::db::meta::row_string(&r, name).unwrap_or_default();
        let name = get("CONSTRAINT_NAME");
        if let Some(f) = out.foreign.iter_mut().find(|f| f.name == name) {
            f.columns.push(get("COLUMN_NAME"));
            f.targets.push(get("REFERENCED_COLUMN_NAME"));
        } else {
            out.foreign.push(Foreign {
                name,
                columns: vec![get("COLUMN_NAME")],
                target: SourceTable {
                    schema: get("REFERENCED_TABLE_SCHEMA"),
                    name: get("REFERENCED_TABLE_NAME"),
                },
                targets: vec![get("REFERENCED_COLUMN_NAME")],
                update: get("UPDATE_RULE"),
                delete: get("DELETE_RULE"),
            });
        }
    }
    notice(&mut out.issues, "table_options", label(table));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selected(schema: &str, names: &[&str]) -> Vec<SourceTable> {
        names
            .iter()
            .map(|n| SourceTable {
                schema: schema.into(),
                name: (*n).into(),
            })
            .collect()
    }
    fn pk_names(t: &Table) -> Vec<String> {
        t.primary_key
            .as_ref()
            .unwrap()
            .iter()
            .map(|id| t.columns.iter().find(|c| c.id == *id).unwrap().name.clone())
            .collect()
    }
    #[tokio::test]
    async fn sqlite_real_metadata_preserves_keys_and_reports_omissions_without_reading_data() {
        let p = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE parent(a INTEGER NOT NULL,b INTEGER NOT NULL,label TEXT DEFAULT 'private default',derived TEXT AS (lower(label)),PRIMARY KEY(b,a),UNIQUE(a,b)); CREATE UNIQUE INDEX partial ON parent(label) WHERE label IS NOT NULL; CREATE UNIQUE INDEX expr ON parent(lower(label)); CREATE UNIQUE INDEX nocase ON parent(label COLLATE NOCASE); CREATE TABLE child(x INTEGER,y INTEGER,FOREIGN KEY(x,y) REFERENCES parent(b,a) ON UPDATE CASCADE ON DELETE SET NULL); CREATE TABLE implicit(x INTEGER,y INTEGER,FOREIGN KEY(x,y) REFERENCES parent); INSERT INTO parent(a,b,label) VALUES(1,2,'source row');").execute(&p).await.unwrap();
        let preview = inspect(
            &DbPool::Sqlite(p.clone()),
            &selected("main", &["parent", "child", "implicit"]),
        )
        .await
        .unwrap();
        let parent = &preview.model.tables[0];
        assert_eq!(pk_names(parent), ["b", "a"]);
        assert_eq!(parent.unique_keys.as_ref().unwrap().len(), 1);
        assert_eq!(preview.model.relations.len(), 2);
        assert_eq!(
            preview.model.relations[0].on_delete.as_deref(),
            Some("SET NULL")
        );
        let implicit = &preview.model.relations[1];
        assert_eq!(
            implicit.to_columns,
            parent.primary_key.as_ref().unwrap().clone()
        );
        assert!(preview.warnings.iter().any(|i| i.code == "generated"));
        assert!(preview.warnings.iter().any(|i| i.code == "default"));
        assert_eq!(
            preview
                .warnings
                .iter()
                .filter(|i| i.code == "index")
                .count(),
            3
        );
        let json = serde_json::to_string(&preview).unwrap();
        assert!(!json.contains("private default") && !json.contains("source row"));
        let dir = tempfile::tempdir().unwrap();
        let store = crate::offline_models::ModelStore::new(dir.path());
        let saved = store
            .save(crate::offline_models::SaveRequest {
                id: None,
                revision: None,
                name: "reverse".into(),
                content: Content {
                    model: preview.model,
                },
            })
            .unwrap();
        assert_eq!(
            pk_names(
                &crate::offline_models::ModelStore::new(dir.path())
                    .get(&saved.id)
                    .unwrap()
                    .content
                    .model
                    .tables[0]
            ),
            ["b", "a"]
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM parent")
            .fetch_one(&p)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let external = inspect(&DbPool::Sqlite(p.clone()), &selected("main", &["child"]))
            .await
            .unwrap();
        assert!(external.model.relations.is_empty());
        assert!(external.warnings.iter().any(|i| i.code == "external_fk"));
        assert!(inspect(
            &DbPool::Sqlite(p.clone()),
            &selected("main", &["parent", "missing"])
        )
        .await
        .is_err());
        assert!(
            inspect(&DbPool::Sqlite(p.clone()), &selected("other", &["parent"]))
                .await
                .is_err()
        );
        sqlx::query("CREATE TABLE \"quote'\"\";DROP TABLE parent;--\"(x)")
            .execute(&p)
            .await
            .unwrap();
        assert!(inspect(
            &DbPool::Sqlite(p.clone()),
            &selected("main", &["quote'\";DROP TABLE parent;--"])
        )
        .await
        .is_ok());
        p.close().await;
    }
    #[tokio::test]
    async fn sqlite_does_not_report_rowid_alias_as_nullable_primary_key() {
        let p = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE alias(id INTEGER PRIMARY KEY);CREATE TABLE legacy(id INT PRIMARY KEY);",
        )
        .execute(&p)
        .await
        .unwrap();
        let plan = inspect(
            &DbPool::Sqlite(p.clone()),
            &selected("main", &["alias", "legacy"]),
        )
        .await
        .unwrap();
        let notices: Vec<_> = plan
            .warnings
            .iter()
            .filter(|i| i.code == "nullable_pk")
            .collect();
        assert_eq!(notices.len(), 1);
        assert!(notices[0].object.contains("legacy"));
        p.close().await;
    }
    #[tokio::test]
    async fn sqlite_rejects_oversized_metadata_instead_of_truncating() {
        let p = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let fields = (0..257)
            .map(|i| format!("c{i} INT"))
            .collect::<Vec<_>>()
            .join(",");
        sqlx::query(&format!("CREATE TABLE large({fields})"))
            .execute(&p)
            .await
            .unwrap();
        assert!(
            inspect(&DbPool::Sqlite(p.clone()), &selected("main", &["large"]))
                .await
                .err()
                .unwrap()
                .to_string()
                .contains("limit")
        );
        p.close().await;
    }
    #[test]
    fn rejects_invalid_or_duplicate_selection_before_metadata_io() {
        assert!(validate_selection(&[]).is_err());
        assert!(validate_selection(&selected("main", &["a", "a"])).is_err());
        assert!(validate_selection(&selected("main", &["a\0b"])).is_err());
        assert!(validate_selection(&vec![
            SourceTable {
                schema: "main".into(),
                name: "a".into()
            };
            201
        ])
        .is_err());
    }
    #[tokio::test]
    async fn postgres_real_reverse_preserves_typmods_order_and_constraints() {
        let Ok(url) = std::env::var("RDB_REVERSE_PG_URL") else {
            return;
        };
        let p = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        let schema = format!("reverse_{}", uuid::Uuid::new_v4().simple());
        let result: AppResult<()> = async {
            sqlx::raw_sql(&format!("CREATE SCHEMA {schema};CREATE TABLE {schema}.parent(a INTEGER,b INTEGER,label VARCHAR(37) DEFAULT 'source secret',n NUMERIC(11,4),tags UUID[],PRIMARY KEY(b,a),CONSTRAINT uq_pair UNIQUE(a,b),CONSTRAINT positive CHECK(a>0));COMMENT ON TABLE {schema}.parent IS '中文表';CREATE UNIQUE INDEX partial_idx ON {schema}.parent(label) WHERE label IS NOT NULL;CREATE TABLE {schema}.child(x INTEGER,y INTEGER,FOREIGN KEY(x,y) REFERENCES {schema}.parent(b,a) ON UPDATE CASCADE ON DELETE SET NULL);")).execute(&p).await?;
            let plan=inspect(&DbPool::Postgres(p.clone()),&selected(&schema,&["parent","child"])).await?;
            let parent=&plan.model.tables[0]; assert_eq!(pk_names(parent),["b","a"]);assert_eq!(parent.comment,"中文表");assert_eq!(parent.columns[2].r#type,"character varying(37)");assert_eq!(parent.columns[3].r#type,"numeric(11,4)");assert_eq!(parent.columns[4].r#type,"uuid[]");assert_eq!(parent.unique_keys.as_ref().unwrap().len(),1);assert_eq!(plan.model.relations.len(),1);assert!(plan.warnings.iter().any(|i|i.code=="constraint"));assert!(plan.warnings.iter().any(|i|i.code=="index"));assert!(!serde_json::to_string(&plan)?.contains("source secret")); Ok(())
        }.await;
        sqlx::query(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
            .execute(&p)
            .await
            .unwrap();
        p.close().await;
        result.unwrap();
    }
    #[tokio::test]
    async fn mysql_real_reverse_preserves_types_key_order_and_actions() {
        let Ok(socket) = std::env::var("RDB_REVERSE_MYSQL_SOCKET") else {
            return;
        };
        let p = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(2)
            .connect_with(
                sqlx::mysql::MySqlConnectOptions::new()
                    .socket(socket)
                    .username("root"),
            )
            .await
            .unwrap();
        let schema = format!("reverse_{}", uuid::Uuid::new_v4().simple());
        let result: AppResult<()> = async {
            for sql in [format!("CREATE DATABASE {schema}"),format!("CREATE TABLE {schema}.parent(a INT NOT NULL,b INT NOT NULL,label VARCHAR(37) DEFAULT 'source secret',n DECIMAL(11,4),PRIMARY KEY(b,a),CONSTRAINT uq_pair UNIQUE(a,b)) ENGINE=InnoDB COMMENT='中文表'"),format!("CREATE TABLE {schema}.child(x INT,y INT,CONSTRAINT fk_parent FOREIGN KEY(x,y) REFERENCES {schema}.parent(b,a) ON UPDATE CASCADE ON DELETE SET NULL) ENGINE=InnoDB")] { sqlx::query(&sql).execute(&p).await?; }
            let plan=inspect(&DbPool::Mysql(p.clone()),&selected(&schema,&["parent","child"])).await?;
            let parent=&plan.model.tables[0];assert_eq!(pk_names(parent),["b","a"]);assert_eq!(parent.comment,"中文表");assert_eq!(parent.columns[2].r#type,"varchar(37)");assert_eq!(parent.columns[3].r#type,"decimal(11,4)");assert_eq!(parent.unique_keys.as_ref().unwrap().len(),1);assert_eq!(plan.model.relations.len(),1);assert_eq!(plan.model.relations[0].on_delete.as_deref(),Some("SET NULL"));assert!(!serde_json::to_string(&plan)?.contains("source secret"));Ok(())
        }.await;
        sqlx::query(&format!("DROP DATABASE IF EXISTS {schema}"))
            .execute(&p)
            .await
            .unwrap();
        p.close().await;
        result.unwrap();
    }
}
