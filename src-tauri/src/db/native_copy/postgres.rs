//! PostgreSQL copies never materialize table rows in the application.
//!
//! LIKE copies owned identity sequences, but copies a serial default verbatim.
//! Serial sequences must therefore be replaced before inserting any rows.

use super::{
    cancelled, fingerprint, CopyPhase, CopyPlan, CopyReport, NativeCopyRequest, ProgressFn,
};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use sqlx::{Connection, PgConnection, PgPool, Row};
use tokio_util::sync::CancellationToken;

#[derive(Serialize)]
struct Column {
    number: i16,
    name: String,
    identity: String,
    generated: String,
    default: Option<String>,
    default_sequences: Vec<i64>,
    signature: String,
}

#[derive(Serialize)]
struct Sequence {
    oid: i64,
    column_number: i16,
    column: String,
    identity: bool,
    direct_default: bool,
    data_type: String,
    start: i64,
    increment: i64,
    min: i64,
    max: i64,
    cache: i64,
    cycle: bool,
    signature: String,
}

#[derive(Serialize)]
struct Metadata {
    schema: String,
    source_table: String,
    target_table: String,
    oid: i64,
    unlogged: bool,
    table_signature: String,
    columns: Vec<Column>,
    sequences: Vec<Sequence>,
    constraints: Vec<String>,
    indexes: Vec<String>,
    statistics: Vec<String>,
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote(schema), quote(table))
}

// Escape strings independently of the connection's standard_conforming_strings.
fn literal(value: &str) -> String {
    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn identifier(value: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > 63 || value.contains('\0') {
        return Err(AppError::msg(
            "PostgreSQL identifiers must be nonempty, at most 63 UTF-8 bytes, and contain no NUL",
        ));
    }
    Ok(())
}

fn check_cancel(cancel: &CancellationToken) -> AppResult<()> {
    if cancel.is_cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}

async fn schema(connection: &mut PgConnection, request: &NativeCopyRequest) -> AppResult<String> {
    identifier(&request.source_table)?;
    identifier(&request.target_table)?;
    if request.source_table == request.target_table {
        return Err(AppError::msg(
            "the source and target table must be different",
        ));
    }
    let schema = match request.schema.as_deref().filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_owned(),
        None => sqlx::query_scalar::<_, Option<String>>("SELECT pg_catalog.current_schema()")
            .fetch_one(&mut *connection)
            .await?
            .ok_or_else(|| AppError::msg("the connection has no current PostgreSQL schema"))?,
    };
    identifier(&schema)?;
    Ok(schema)
}

async fn metadata(
    connection: &mut PgConnection,
    request: &NativeCopyRequest,
    schema: &str,
    cancel: &CancellationToken,
) -> AppResult<Metadata> {
    check_cancel(cancel)?;
    let target_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace \
         WHERE n.nspname=$1 AND c.relname=$2)",
    )
    .bind(schema)
    .bind(&request.target_table)
    .fetch_one(&mut *connection)
    .await?;
    if target_exists {
        return Err(AppError::msg(
            "the target PostgreSQL relation already exists",
        ));
    }
    check_cancel(cancel)?;
    let table = sqlx::query(
        "SELECT c.oid::bigint AS oid, c.relkind::text AS kind, \
         c.relpersistence::text AS persistence, c.relispartition, c.relrowsecurity, \
         c.relforcerowsecurity, c.relhasrules, c.reloftype::bigint AS oftype, am.amname, \
         EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i \
                WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited, \
         jsonb_build_array(c.oid, c.relkind, c.relpersistence, c.relnamespace, \
           c.relowner, c.reloptions, c.reltablespace, c.relreplident, \
           c.relrowsecurity, c.relforcerowsecurity, c.relacl, c.relispartition, \
           c.relhasrules, c.reloftype, c.relam, \
           pg_catalog.obj_description(c.oid,'pg_class'))::text AS signature \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace \
         LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam \
         WHERE n.nspname=$1 AND c.relname=$2",
    )
    .bind(schema)
    .bind(&request.source_table)
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| AppError::msg("the source PostgreSQL table does not exist"))?;
    if table.try_get::<String, _>("kind")? != "r"
        || table.try_get::<String, _>("persistence")? == "t"
        || table.try_get::<Option<String>, _>("amname")?.as_deref() != Some("heap")
        || table.try_get::<bool, _>("relispartition")?
        || table.try_get::<bool, _>("inherited")?
        || table.try_get::<bool, _>("relrowsecurity")?
        || table.try_get::<bool, _>("relforcerowsecurity")?
        || table.try_get::<bool, _>("relhasrules")?
        || table.try_get::<i64, _>("oftype")? != 0
    {
        return Err(AppError::msg(
            "native PostgreSQL copy supports ordinary heap tables without partitioning, inheritance, row security, rules, or typed-table bindings",
        ));
    }
    let oid: i64 = table.try_get("oid")?;
    check_cancel(cancel)?;
    let column_rows = sqlx::query(
        "SELECT a.attnum, a.attname, a.attidentity::text AS identity_kind, \
         a.attgenerated::text AS generated_kind, \
         pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expr, \
         ARRAY(SELECT dep.refobjid::bigint FROM pg_catalog.pg_depend dep \
           JOIN pg_catalog.pg_class seq ON seq.oid=dep.refobjid AND seq.relkind='S' \
           WHERE dep.classid='pg_catalog.pg_attrdef'::regclass AND dep.objid=d.oid \
             AND dep.refclassid='pg_catalog.pg_class'::regclass ORDER BY dep.refobjid) AS default_sequences, \
         (to_jsonb(a) || jsonb_build_object('default',pg_catalog.pg_get_expr(d.adbin,d.adrelid), \
           'comment',pg_catalog.col_description(a.attrelid,a.attnum)))::text AS signature \
         FROM pg_catalog.pg_attribute a \
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum \
         WHERE a.attrelid=$1::bigint::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
    )
    .bind(oid)
    .fetch_all(&mut *connection)
    .await?;
    let mut columns = Vec::with_capacity(column_rows.len());
    for row in column_rows {
        columns.push(Column {
            number: row.try_get("attnum")?,
            name: row.try_get("attname")?,
            identity: row.try_get("identity_kind")?,
            generated: row.try_get("generated_kind")?,
            default: row.try_get("default_expr")?,
            default_sequences: row.try_get("default_sequences")?,
            signature: row.try_get("signature")?,
        });
    }
    check_cancel(cancel)?;
    let sequence_rows = sqlx::query(
        "SELECT seq.oid::bigint AS oid, a.attnum, a.attname, a.attidentity<>'' AS identity_kind, \
         COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid)= \
           format('nextval(%L::regclass)',seq.oid::regclass::text),false) AS direct_default, \
         pg_catalog.format_type(s.seqtypid,NULL) AS data_type, \
         s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle, \
         jsonb_build_array(to_jsonb(s),seq.relname,seq.relnamespace,dep.deptype, \
           pg_catalog.obj_description(seq.oid,'pg_class'))::text AS signature \
         FROM pg_catalog.pg_depend dep \
         JOIN pg_catalog.pg_class seq ON seq.oid=dep.objid AND seq.relkind='S' \
         JOIN pg_catalog.pg_sequence s ON s.seqrelid=seq.oid \
         JOIN pg_catalog.pg_attribute a ON a.attrelid=dep.refobjid AND a.attnum=dep.refobjsubid \
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum \
         WHERE dep.classid='pg_catalog.pg_class'::regclass \
           AND dep.refclassid='pg_catalog.pg_class'::regclass \
           AND dep.refobjid=$1::bigint::oid AND dep.deptype IN ('a','i') \
         ORDER BY a.attnum,seq.oid",
    )
    .bind(oid)
    .fetch_all(&mut *connection)
    .await?;
    let mut sequences = Vec::with_capacity(sequence_rows.len());
    for row in sequence_rows {
        sequences.push(Sequence {
            oid: row.try_get("oid")?,
            column_number: row.try_get("attnum")?,
            column: row.try_get("attname")?,
            identity: row.try_get("identity_kind")?,
            direct_default: row.try_get("direct_default")?,
            data_type: row.try_get("data_type")?,
            start: row.try_get("seqstart")?,
            increment: row.try_get("seqincrement")?,
            min: row.try_get("seqmin")?,
            max: row.try_get("seqmax")?,
            cache: row.try_get("seqcache")?,
            cycle: row.try_get("seqcycle")?,
            signature: row.try_get("signature")?,
        });
    }
    for column in &columns {
        let owned: Vec<_> = sequences
            .iter()
            .filter(|s| s.column_number == column.number)
            .collect();
        let uses_sequence = !column.default_sequences.is_empty()
            || column
                .default
                .as_deref()
                .is_some_and(|d| d.to_ascii_lowercase().contains("nextval("));
        let valid_serial = owned.len() == 1
            && !owned[0].identity
            && owned[0].direct_default
            && column.default_sequences == vec![owned[0].oid];
        let valid_identity = owned.len() == 1 && owned[0].identity && !column.identity.is_empty();
        if (uses_sequence && !valid_serial)
            || (!column.identity.is_empty() && !valid_identity)
            || (!owned.is_empty() && !valid_serial && !valid_identity)
        {
            return Err(AppError::msg(format!(
                "column {} uses a shared, unowned, or complex sequence default that cannot be copied safely",
                quote(&column.name)
            )));
        }
    }
    check_cancel(cancel)?;
    let constraints = sqlx::query_scalar(
        "SELECT jsonb_build_array(to_jsonb(c),pg_catalog.pg_get_constraintdef(c.oid), \
           pg_catalog.obj_description(c.oid,'pg_constraint'))::text \
         FROM pg_catalog.pg_constraint c WHERE c.conrelid=$1::bigint::oid ORDER BY c.oid",
    )
    .bind(oid)
    .fetch_all(&mut *connection)
    .await?;
    check_cancel(cancel)?;
    let index_rows = sqlx::query(
        "SELECT i.indisvalid AND i.indisready AND i.indislive AS valid, \
         jsonb_build_array(to_jsonb(i),pg_catalog.pg_get_indexdef(i.indexrelid), \
           c.reloptions, c.reltablespace,pg_catalog.obj_description(c.oid,'pg_class'))::text AS signature \
         FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid \
         WHERE i.indrelid=$1::bigint::oid ORDER BY i.indexrelid",
    )
    .bind(oid)
    .fetch_all(&mut *connection)
    .await?;
    let mut indexes = Vec::with_capacity(index_rows.len());
    for row in index_rows {
        if !row.try_get::<bool, _>("valid")? {
            return Err(AppError::msg(
                "a source index is invalid or still being built; retry after repairing it",
            ));
        }
        indexes.push(row.try_get("signature")?);
    }
    check_cancel(cancel)?;
    let statistics = sqlx::query_scalar(
        "SELECT jsonb_build_array(to_jsonb(s),pg_catalog.pg_get_statisticsobjdef(s.oid), \
           pg_catalog.obj_description(s.oid,'pg_statistic_ext'))::text \
         FROM pg_catalog.pg_statistic_ext s WHERE s.stxrelid=$1::bigint::oid ORDER BY s.oid",
    )
    .bind(oid)
    .fetch_all(&mut *connection)
    .await?;
    Ok(Metadata {
        schema: schema.to_owned(),
        source_table: request.source_table.clone(),
        target_table: request.target_table.clone(),
        oid,
        unlogged: table.try_get::<String, _>("persistence")? == "u",
        table_signature: table.try_get("signature")?,
        columns,
        sequences,
        constraints,
        indexes,
        statistics,
    })
}

fn metadata_fingerprint(metadata: &Metadata) -> AppResult<String> {
    Ok(fingerprint(&serde_json::to_string(metadata)?))
}

fn serial_name(metadata: &Metadata, sequence: &Sequence) -> String {
    // The digest avoids identifier truncation and collisions between long names.
    let hash = fingerprint(&format!(
        "{}\0{}\0{}",
        metadata.schema, metadata.target_table, sequence.column
    ));
    format!(
        "rdbcopy_{}_{}_seq",
        metadata.oid,
        hash.chars().take(32).collect::<String>()
    )
}

fn create_statements(metadata: &Metadata) -> Vec<String> {
    let source = qualified(&metadata.schema, &metadata.source_table);
    let target = qualified(&metadata.schema, &metadata.target_table);
    let persistence = if metadata.unlogged { "UNLOGGED " } else { "" };
    let mut statements = vec![format!(
        "CREATE {persistence}TABLE {target} (LIKE {source} INCLUDING ALL)"
    )];
    for sequence in metadata
        .sequences
        .iter()
        .filter(|sequence| !sequence.identity)
    {
        let name = qualified(&metadata.schema, &serial_name(metadata, sequence));
        let column = quote(&sequence.column);
        statements.push(format!(
            "CREATE SEQUENCE {name} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {} {}",
            sequence.data_type, sequence.increment, sequence.min, sequence.max,
            sequence.start, sequence.cache, if sequence.cycle { "CYCLE" } else { "NO CYCLE" }
        ));
        statements.push(format!("ALTER SEQUENCE {name} OWNED BY {target}.{column}"));
        statements.push(format!(
            "ALTER TABLE {target} ALTER COLUMN {column} SET DEFAULT pg_catalog.nextval({}::regclass)",
            literal(&name)
        ));
    }
    statements
}

fn insert_statement(metadata: &Metadata) -> String {
    let columns = metadata
        .columns
        .iter()
        .filter(|column| column.generated.is_empty())
        .map(|column| quote(&column.name))
        .collect::<Vec<_>>()
        .join(", ");
    let target = qualified(&metadata.schema, &metadata.target_table);
    let source = qualified(&metadata.schema, &metadata.source_table);
    if columns.is_empty() {
        format!("INSERT INTO {target} OVERRIDING SYSTEM VALUE SELECT FROM {source}")
    } else {
        format!("INSERT INTO {target} ({columns}) OVERRIDING SYSTEM VALUE SELECT {columns} FROM {source}")
    }
}

fn sequence_statements(metadata: &Metadata) -> Vec<String> {
    let target = qualified(&metadata.schema, &metadata.target_table);
    metadata
        .sequences
        .iter()
        .map(|sequence| {
            let aggregate = if sequence.increment > 0 { "MAX" } else { "MIN" };
            let comparison = if sequence.increment > 0 { ">=" } else { "<=" };
            let start = sequence.start;
            // For empty tables or values before START, the first nextval must return START.
            // Existing values past the sequence's legal bounds fail and roll back the copy.
            format!(
                "SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence({}, {})::regclass, \
             CASE WHEN v {comparison} {start} THEN v ELSE {start} END, \
             COALESCE(v {comparison} {start}, false)) \
             FROM (SELECT {aggregate}({})::bigint AS v FROM {target}) AS copied_values",
                literal(&target),
                literal(&sequence.column),
                quote(&sequence.column)
            )
        })
        .collect()
}

fn plan(metadata: &Metadata) -> AppResult<CopyPlan> {
    let source = qualified(&metadata.schema, &metadata.source_table);
    let mut statements = vec![
        "BEGIN ISOLATION LEVEL REPEATABLE READ".into(),
        format!("LOCK TABLE ONLY {source} IN ACCESS SHARE MODE"),
    ];
    statements.extend(create_statements(metadata));
    statements.push(insert_statement(metadata));
    statements.extend(sequence_statements(metadata));
    statements.push("COMMIT".into());
    Ok(CopyPlan {
        fingerprint: metadata_fingerprint(metadata)?,
        statements,
        warnings: vec![
            "Foreign keys, triggers, ownership, and privileges are not copied.".into(),
            "Table-level storage options, tablespace, replica identity, and table comments are not copied.".into(),
            "Serial and identity sequences are independent and restart after the copied values; the source sequence counter is unchanged.".into(),
        ],
        transactional: true,
    })
}

pub async fn preview(pool: &PgPool, request: &NativeCopyRequest) -> AppResult<CopyPlan> {
    let mut connection = pool.acquire().await?;
    let schema = schema(&mut connection, request).await?;
    let metadata = metadata(&mut connection, request, &schema, &CancellationToken::new()).await?;
    plan(&metadata)
}

async fn copy_in_transaction(
    connection: &mut PgConnection,
    request: &NativeCopyRequest,
    schema: &str,
    expected: &str,
    cancel: &CancellationToken,
    progress: &ProgressFn,
) -> AppResult<CopyReport> {
    check_cancel(cancel)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *connection)
        .await?;
    check_cancel(cancel)?;
    // Acquire the relation lock before establishing the repeatable-read snapshot.
    sqlx::query(&format!(
        "LOCK TABLE ONLY {} IN ACCESS SHARE MODE",
        qualified(schema, &request.source_table)
    ))
    .execute(&mut *connection)
    .await?;
    let metadata = metadata(connection, request, schema, cancel).await?;
    if metadata_fingerprint(&metadata)? != expected {
        return Err(AppError::msg(
            "the source table structure changed after preview; preview the copy again",
        ));
    }
    progress(CopyPhase::Creating);
    for statement in create_statements(&metadata) {
        check_cancel(cancel)?;
        sqlx::query(&statement).execute(&mut *connection).await?;
    }
    progress(CopyPhase::Copying);
    check_cancel(cancel)?;
    let rows_copied = sqlx::query(&insert_statement(&metadata))
        .execute(&mut *connection)
        .await?
        .rows_affected();
    for statement in sequence_statements(&metadata) {
        check_cancel(cancel)?;
        sqlx::query(&statement).execute(&mut *connection).await?;
    }
    check_cancel(cancel)?;
    Ok(CopyReport { rows_copied })
}

pub async fn execute(
    pool: &PgPool,
    request: &NativeCopyRequest,
    expected: &str,
    cancel: CancellationToken,
    progress: ProgressFn,
) -> AppResult<CopyReport> {
    progress(CopyPhase::Preparing);
    check_cancel(&cancel)?;
    let mut connection = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(cancelled()),
        result = pool.acquire() => result?,
    };
    // Never return a backend targeted by asynchronous cancellation to another
    // operation. This also guarantees rollback by disconnect if cleanup fails.
    connection.close_on_drop();
    let schema = schema(&mut connection, request).await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_catalog.pg_backend_pid()")
        .fetch_one(&mut *connection)
        .await?;
    // A separate physical connection also works when the data pool has max_connections=1.
    let options = pool.connect_options();
    let mut cancel_connection = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(cancelled()),
        result = PgConnection::connect_with(&options) => result?,
    };
    let mut transaction = connection.begin().await?;
    let result = {
        let work = copy_in_transaction(
            &mut transaction,
            request,
            &schema,
            expected,
            &cancel,
            &progress,
        );
        tokio::pin!(work);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                progress(CopyPhase::Cancelling);
                // Keep polling the work while signaling: the first signal can arrive
                // just before a pending query has reached the server.
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut work => break,
                        _ = interval.tick() => {
                            // Fully receive each cancellation acknowledgement so
                            // an in-flight signal cannot escape this operation.
                            let _ = sqlx::query("SELECT pg_catalog.pg_cancel_backend($1)")
                                .bind(pid).execute(&mut cancel_connection).await;
                        }
                    }
                }
                Err(cancelled())
            }
            result = &mut work => result,
        }
    };
    match result {
        Ok(report) => {
            progress(CopyPhase::Finishing);
            if cancel.is_cancelled() {
                progress(CopyPhase::Cancelling);
                transaction.rollback().await?;
                return Err(cancelled());
            }
            transaction.commit().await?;
            Ok(report)
        }
        Err(error) => {
            transaction.rollback().await?;
            if cancel.is_cancelled() {
                Err(cancelled())
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    async fn test_pool() -> Option<PgPool> {
        let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
            eprintln!("skipped PostgreSQL native-copy test: RDBSTUDIO_TEST_PG_URL is not set");
            return None;
        };
        Some(
            sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .unwrap(),
        )
    }

    fn request(schema: &str, source: &str, target: &str) -> NativeCopyRequest {
        NativeCopyRequest {
            schema: Some(schema.into()),
            source_table: source.into(),
            target_table: target.into(),
        }
    }

    async fn fixture(pool: &PgPool) -> String {
        let schema = format!("rdb_native_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {}", quote(&schema)))
            .execute(pool)
            .await
            .unwrap();
        schema
    }

    async fn cleanup(pool: &PgPool, schema: &str) {
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", quote(schema)))
            .execute(pool)
            .await
            .unwrap();
        pool.close().await;
    }

    async fn copy(pool: &PgPool, request: &NativeCopyRequest) -> CopyReport {
        let plan = preview(pool, request).await.unwrap();
        execute(
            pool,
            request,
            &plan.fingerprint,
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap()
    }

    #[test]
    fn identifier_validation_and_literals_do_not_truncate_or_interpolate() {
        assert!(identifier(&"界".repeat(21)).is_ok());
        assert!(identifier(&"界".repeat(22)).is_err());
        assert!(identifier("bad\0name").is_err());
        assert!(identifier("").is_err());
        assert_eq!(quote("odd\"name"), "\"odd\"\"name\"");
        assert_eq!(literal("a'\\b"), "E'a''\\\\b'");
    }

    #[tokio::test]
    async fn copies_twelve_thousand_rows_without_primary_key_and_preserves_native_values() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let schema = fixture(&pool).await;
        let src = qualified(&schema, "source");
        let dst = qualified(&schema, "target");
        sqlx::raw_sql(&format!(
            "CREATE TABLE {src} (n bigint, exact numeric(30,8), payload bytea, note text); \
             INSERT INTO {src} SELECT n,9007199254740993.12345678,decode('00ff1080','hex'),NULL \
             FROM generate_series(1,12000) n"
        ))
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            copy(&pool, &request(&schema, "source", "target"))
                .await
                .rows_copied,
            12000
        );
        let equal: bool = sqlx::query_scalar(&format!(
            "SELECT NOT EXISTS((TABLE {src} EXCEPT ALL TABLE {dst}) UNION ALL \
             (TABLE {dst} EXCEPT ALL TABLE {src}))"
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(equal);
        cleanup(&pool, &schema).await;
    }

    #[tokio::test]
    async fn serial_and_identity_sequences_are_independent_and_generated_constraints_survive() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let schema = fixture(&pool).await;
        let src = qualified(&schema, "source");
        let dst = qualified(&schema, "target");
        sqlx::raw_sql(&format!(
            "CREATE TABLE {src} (id bigserial PRIMARY KEY, \
             ident bigint GENERATED ALWAYS AS IDENTITY (START WITH 10 INCREMENT BY 3), \
             descending bigint GENERATED BY DEFAULT AS IDENTITY (START WITH -2 INCREMENT BY -2), \
             n integer NOT NULL CHECK (n>0), doubled integer GENERATED ALWAYS AS (n*2) STORED, \
             UNIQUE(n)); \
             INSERT INTO {src}(n) VALUES(2),(3); \
             INSERT INTO {src}(id,ident,descending,n) OVERRIDING SYSTEM VALUE VALUES(100,100,-100,4)"
        )).execute(&pool).await.unwrap();
        let source_sequence: String =
            sqlx::query_scalar("SELECT pg_catalog.pg_get_serial_sequence($1,'id')")
                .bind(&src)
                .fetch_one(&pool)
                .await
                .unwrap();
        let source_counter: i64 =
            sqlx::query_scalar(&format!("SELECT last_value FROM {source_sequence}"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            copy(&pool, &request(&schema, "source", "target"))
                .await
                .rows_copied,
            3
        );
        let target_sequence: String =
            sqlx::query_scalar("SELECT pg_catalog.pg_get_serial_sequence($1,'id')")
                .bind(&dst)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_ne!(source_sequence, target_sequence);
        let source_after: i64 =
            sqlx::query_scalar(&format!("SELECT last_value FROM {source_sequence}"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(source_counter, source_after);
        let row = sqlx::query(&format!(
            "INSERT INTO {dst}(n) VALUES(5) RETURNING id,ident,descending,doubled"
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<i64, _>("id"), 101);
        assert_eq!(row.get::<i64, _>("ident"), 103);
        assert_eq!(row.get::<i64, _>("descending"), -102);
        assert_eq!(row.get::<i32, _>("doubled"), 10);
        assert!(sqlx::query(&format!("INSERT INTO {dst}(n) VALUES(0)"))
            .execute(&pool)
            .await
            .is_err());
        assert!(sqlx::query(&format!("INSERT INTO {dst}(n) VALUES(5)"))
            .execute(&pool)
            .await
            .is_err());
        // Dropping the source also drops its owned serial sequence; target defaults still work.
        sqlx::query(&format!("DROP TABLE {src}"))
            .execute(&pool)
            .await
            .unwrap();
        assert!(sqlx::query(&format!("INSERT INTO {dst}(n) VALUES(6)"))
            .execute(&pool)
            .await
            .is_ok());
        cleanup(&pool, &schema).await;
    }

    #[tokio::test]
    async fn existing_target_and_stale_preview_cannot_overwrite_anything() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let schema = fixture(&pool).await;
        let src = qualified(&schema, "source");
        let dst = qualified(&schema, "target");
        sqlx::raw_sql(&format!(
            "CREATE TABLE {src}(n int); INSERT INTO {src} VALUES(1)"
        ))
        .execute(&pool)
        .await
        .unwrap();
        let req = request(&schema, "source", "target");
        let plan = preview(&pool, &req).await.unwrap();
        sqlx::raw_sql(&format!(
            "CREATE TABLE {dst}(sentinel text); INSERT INTO {dst} VALUES('keep')"
        ))
        .execute(&pool)
        .await
        .unwrap();
        assert!(preview(&pool, &req).await.is_err());
        assert!(execute(
            &pool,
            &req,
            &plan.fingerprint,
            CancellationToken::new(),
            Arc::new(|_| {})
        )
        .await
        .is_err());
        let sentinel: String = sqlx::query_scalar(&format!("SELECT sentinel FROM {dst}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(sentinel, "keep");
        sqlx::query(&format!("DROP TABLE {dst}"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(&format!("ALTER TABLE {src} ADD COLUMN changed text"))
            .execute(&pool)
            .await
            .unwrap();
        assert!(execute(
            &pool,
            &req,
            &plan.fingerprint,
            CancellationToken::new(),
            Arc::new(|_| {})
        )
        .await
        .is_err());
        let target: Option<String> = sqlx::query_scalar("SELECT pg_catalog.to_regclass($1)::text")
            .bind(&dst)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(target.is_none());
        cleanup(&pool, &schema).await;
    }

    #[tokio::test]
    async fn empty_identity_keeps_start_and_generated_only_rows_copy() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let schema = fixture(&pool).await;
        let src = qualified(&schema, "source");
        let dst = qualified(&schema, "target");
        sqlx::query(&format!(
            "CREATE TABLE {src}(id bigint GENERATED ALWAYS AS IDENTITY (START WITH 10 INCREMENT BY 3))"
        )).execute(&pool).await.unwrap();
        assert_eq!(
            copy(&pool, &request(&schema, "source", "target"))
                .await
                .rows_copied,
            0
        );
        let first: i64 =
            sqlx::query_scalar(&format!("INSERT INTO {dst} DEFAULT VALUES RETURNING id"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(first, 10);
        let generated = qualified(&schema, "generated");
        sqlx::raw_sql(&format!(
            "CREATE TABLE {generated}(n int GENERATED ALWAYS AS(42) STORED); \
             INSERT INTO {generated} DEFAULT VALUES"
        ))
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            copy(&pool, &request(&schema, "generated", "generated_copy"))
                .await
                .rows_copied,
            1
        );
        let value: i32 = sqlx::query_scalar(&format!(
            "SELECT n FROM {}",
            qualified(&schema, "generated_copy")
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(value, 42);
        cleanup(&pool, &schema).await;
    }

    #[tokio::test]
    async fn cancellation_after_create_and_before_commit_rolls_back_every_object() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let schema = fixture(&pool).await;
        let src = qualified(&schema, "source");
        sqlx::raw_sql(&format!(
            "CREATE TABLE {src}(id serial,n int); INSERT INTO {src}(n) VALUES(7)"
        ))
        .execute(&pool)
        .await
        .unwrap();
        for (target, finish) in [("cancel_copy", false), ("cancel_finish", true)] {
            let req = request(&schema, "source", target);
            let plan = preview(&pool, &req).await.unwrap();
            let cancel = CancellationToken::new();
            let signal = cancel.clone();
            let progress: ProgressFn = Arc::new(move |phase| {
                if (!finish && matches!(phase, CopyPhase::Copying))
                    || (finish && matches!(phase, CopyPhase::Finishing))
                {
                    signal.cancel();
                }
            });
            assert!(execute(&pool, &req, &plan.fingerprint, cancel, progress)
                .await
                .is_err());
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
            )
            .bind(&schema)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                count, 2,
                "only the source table and source serial sequence may remain"
            );
        }
        cleanup(&pool, &schema).await;
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_running_insert_with_a_single_connection_pool() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let schema = fixture(&pool).await;
        let src = qualified(&schema, "source");
        let check = qualified(&schema, "slow_check");
        sqlx::raw_sql(&format!(
            "CREATE FUNCTION {check}(integer) RETURNS boolean LANGUAGE plpgsql AS \
             $$ BEGIN RETURN true; END $$; \
             CREATE TABLE {src}(n int CHECK ({check}(n))); INSERT INTO {src} VALUES(1); \
             CREATE OR REPLACE FUNCTION {check}(integer) RETURNS boolean LANGUAGE plpgsql AS \
             $$ BEGIN PERFORM pg_catalog.pg_sleep(30); RETURN true; END $$"
        ))
        .execute(&pool)
        .await
        .unwrap();
        let req = request(&schema, "source", "target");
        let plan = preview(&pool, &req).await.unwrap();
        let cancel = CancellationToken::new();
        let copying = Arc::new(tokio::sync::Notify::new());
        let notified = copying.clone();
        let signal = cancel.clone();
        let canceller = tokio::spawn(async move {
            notified.notified().await;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            signal.cancel();
        });
        let progress: ProgressFn = Arc::new(move |phase| {
            if matches!(phase, CopyPhase::Copying) {
                copying.notify_one();
            }
        });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            execute(&pool, &req, &plan.fingerprint, cancel, progress),
        )
        .await
        .expect("pg_cancel_backend must interrupt the sleeping INSERT promptly");
        canceller.await.unwrap();
        assert!(result.is_err());
        let target: Option<String> = sqlx::query_scalar("SELECT pg_catalog.to_regclass($1)::text")
            .bind(qualified(&schema, "target"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(target.is_none());
        cleanup(&pool, &schema).await;
    }

    #[tokio::test]
    async fn shared_and_complex_sequence_defaults_are_rejected() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let schema = fixture(&pool).await;
        let sequence = qualified(&schema, "shared");
        let src = qualified(&schema, "source");
        sqlx::raw_sql(&format!(
            "CREATE SEQUENCE {sequence}; CREATE TABLE {src}(id bigint DEFAULT nextval({}::regclass))",
            literal(&sequence)
        )).execute(&pool).await.unwrap();
        let req = request(&schema, "source", "target");
        assert!(preview(&pool, &req).await.is_err());
        sqlx::raw_sql(&format!(
            "ALTER SEQUENCE {sequence} OWNED BY {src}.id; \
             ALTER TABLE {src} ALTER COLUMN id SET DEFAULT nextval({}::regclass)+1",
            literal(&sequence)
        ))
        .execute(&pool)
        .await
        .unwrap();
        assert!(preview(&pool, &req).await.is_err());
        cleanup(&pool, &schema).await;
    }
}
