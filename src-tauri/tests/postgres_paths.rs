//! PostgreSQL paths against a live server.
//!
//! Covers what used to fail or silently null out: temporal / numeric / array
//! decoding, text binds for grid edits and CSV import (42804), LIKE and
//! numeric-comparison filters, and synthesized DDL for sequences, arrays and
//! views.
//!
//! Needs a superuser (or CREATEDB) role; each test creates and drops its own
//! scratch database:
//!
//! ```text
//! RDBSTUDIO_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres \
//!     cargo test --test postgres_paths
//! ```

use rdbstudio_lib::db::data::{self, Edit, EditBatch, Filter, FilterOp, TableQuery};
use rdbstudio_lib::db::io::{self, ImportCsvOptions, ImportMode};
use rdbstudio_lib::db::pool::DbPool;
use rdbstudio_lib::db::{design, exec};
use serde_json::json;

async fn scratch(base: &str, name: &str) -> (sqlx::PgPool, DbPool, sqlx::PgPool) {
    let admin = sqlx::PgPool::connect(base).await.expect("connect admin");
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {name}"))
        .execute(&admin)
        .await
        .expect("drop stale scratch database");
    sqlx::raw_sql(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .expect("create scratch database");
    let url = base
        .rsplit_once('/')
        .map(|(host, _)| format!("{host}/{name}"))
        .expect("connection URL carries a database");
    let pool = sqlx::PgPool::connect(&url).await.expect("connect scratch");
    (admin, DbPool::Postgres(pool.clone()), pool)
}

async fn finish(admin: sqlx::PgPool, db: DbPool, pool: sqlx::PgPool, name: &str) {
    drop(db);
    pool.close().await;
    sqlx::raw_sql(&format!("DROP DATABASE {name}"))
        .execute(&admin)
        .await
        .expect("drop scratch database");
}

fn table_query(table: &str) -> TableQuery {
    TableQuery {
        schema: None,
        table: table.into(),
        limit: 50,
        offset: 0,
        order_by: None,
        filters: vec![],
        where_raw: None,
    }
}

#[tokio::test]
async fn temporal_numeric_array_and_bigint_columns_decode() {
    let Ok(base) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_PG_URL is not set");
        return;
    };
    let name = "rdbstudio_pg_decode_test";
    let (admin, db, pool) = scratch(&base, name).await;
    exec::execute(
        &db,
        "CREATE TABLE t (id serial PRIMARY KEY, d date, tm time, ts timestamptz, \
         n numeric(10,2), arr text[], big int8, u uuid, name text)",
    )
    .await
    .expect("create table");
    exec::execute(
        &db,
        "INSERT INTO t (d, tm, ts, n, arr, big, u, name) VALUES \
         ('2024-01-01','13:45:30','2024-01-01 13:45:30+00',1234.56,ARRAY['a','b'], \
          9223372036854775807,'00000000-0000-0000-0000-000000000001','widget')",
    )
    .await
    .expect("seed row");

    let r = exec::execute(&db, "SELECT * FROM t").await.expect("select");
    let row = &r.rows[0];
    assert_eq!(row[1], json!("2024-01-01"), "DATE: {:?}", r.rows);
    assert_eq!(row[2], json!("13:45:30"), "TIME: {:?}", r.rows);
    let ts = row[3].as_str().unwrap_or_default();
    assert!(
        ts.starts_with("2024-01-01T13:45:30"),
        "TIMESTAMPTZ: {:?}",
        r.rows
    );
    assert_eq!(row[4], json!("1234.56"), "NUMERIC: {:?}", r.rows);
    assert_eq!(row[5], json!(["a", "b"]), "TEXT[]: {:?}", r.rows);
    assert_eq!(
        row[6],
        json!("9223372036854775807"),
        "INT8 past 2^53 must be a string: {:?}",
        r.rows
    );
    assert_eq!(
        row[7],
        json!("00000000-0000-0000-0000-000000000001"),
        "UUID: {:?}",
        r.rows
    );

    // The grid path shares the decoders.
    let grid = data::fetch(&db, &table_query("t")).await.expect("fetch");
    assert_eq!(grid.rows[0][1], json!("2024-01-01"));
    assert_eq!(grid.rows[0][4], json!("1234.56"));

    finish(admin, db, pool, name).await;
}

#[tokio::test]
async fn pg_edits_and_import_bind_text_to_typed_columns() {
    let Ok(base) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_PG_URL is not set");
        return;
    };
    let name = "rdbstudio_pg_edit_test";
    let (admin, db, pool) = scratch(&base, name).await;
    exec::execute(
        &db,
        "CREATE TABLE t (id serial PRIMARY KEY, d date, n numeric(10,2), name text)",
    )
    .await
    .expect("create table");
    exec::execute(
        &db,
        "INSERT INTO t (d, n, name) VALUES ('2024-01-01', 1.00, 'first')",
    )
    .await
    .expect("seed row");

    // Grid Update where the date/numeric cells arrive as JSON strings.
    let batch = EditBatch {
        schema: None,
        table: "t".into(),
        edits: vec![Edit::Update {
            pk: vec![("id".into(), json!(1))],
            set: vec![
                ("d".into(), json!("2024-06-01")),
                ("n".into(), json!("42.50")),
            ],
        }],
    };
    let res = data::apply_edits(&db, &batch).await.expect("apply update");
    assert!(res.ok, "update failed: {res:?}");

    // Grid Insert into the same non-text columns.
    let batch = EditBatch {
        schema: None,
        table: "t".into(),
        edits: vec![Edit::Insert {
            values: vec![
                ("d".into(), json!("2024-07-01")),
                ("n".into(), json!("7.25")),
                ("name".into(), json!("second")),
            ],
        }],
    };
    let res = data::apply_edits(&db, &batch).await.expect("apply insert");
    assert!(res.ok, "insert failed: {res:?}");

    let r = exec::execute(
        &db,
        "SELECT d::text, n::text, name FROM t ORDER BY id",
    )
    .await
    .expect("read back");
    assert_eq!(r.rows[0][0], json!("2024-06-01"), "{:?}", r.rows);
    assert_eq!(r.rows[0][1], json!("42.50"), "{:?}", r.rows);
    assert_eq!(r.rows[1][0], json!("2024-07-01"), "{:?}", r.rows);
    assert_eq!(r.rows[1][1], json!("7.25"), "{:?}", r.rows);

    // CSV import into a typed table (previously 42804 for any non-text column).
    exec::execute(
        &db,
        "CREATE TABLE imp (id integer PRIMARY KEY, d date, n numeric(10,2), name text)",
    )
    .await
    .expect("create imp");
    let file = std::env::temp_dir().join("rdbstudio_pg_import_test.csv");
    std::fs::write(
        &file,
        "id,d,n,name\n1,2024-01-01,10.50,alpha\n2,2024-02-02,20.25,beta\n",
    )
    .expect("write csv");
    let opts = ImportCsvOptions {
        path: file.to_string_lossy().into_owned(),
        schema: None,
        table: "imp".into(),
        delimiter: ',',
        has_header: true,
        mode: ImportMode::Append,
        column_map: None,
    };
    let report = io::import_csv(&db, &opts).await.expect("csv import");
    assert_eq!(report.rows_inserted, 2, "{report:?}");
    assert!(report.errors.is_empty(), "{report:?}");

    let r = exec::execute(&db, "SELECT d::text, n::text FROM imp ORDER BY id")
        .await
        .expect("read imp");
    assert_eq!(r.rows[0][0], json!("2024-01-01"), "{:?}", r.rows);
    assert_eq!(r.rows[0][1], json!("10.50"), "{:?}", r.rows);
    let _ = std::fs::remove_file(&file);

    finish(admin, db, pool, name).await;
}

#[tokio::test]
async fn pg_contains_and_numeric_comparison_filters_run() {
    let Ok(base) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_PG_URL is not set");
        return;
    };
    let name = "rdbstudio_pg_filter_test";
    let (admin, db, pool) = scratch(&base, name).await;
    exec::execute(
        &db,
        "CREATE TABLE f (id int PRIMARY KEY, age int, score numeric(6,2), name text)",
    )
    .await
    .expect("create table");
    exec::execute(
        &db,
        "INSERT INTO f VALUES (1, 30, 9.50, 'widget'), (2, 5, 100.25, '5'), (3, 40, 7.00, 'gadget')",
    )
    .await
    .expect("seed");

    let contains = TableQuery {
        filters: vec![Filter {
            column: "name".into(),
            op: FilterOp::Contains,
            value: Some("wid".into()),
        }],
        ..table_query("f")
    };
    let r = data::fetch(&db, &contains).await.expect("contains");
    assert_eq!(r.rows.len(), 1, "{:?}", r.rows);

    // Integer column with a numeric-looking value.
    let gt_int = TableQuery {
        filters: vec![Filter {
            column: "age".into(),
            op: FilterOp::Gt,
            value: Some("10".into()),
        }],
        ..table_query("f")
    };
    let r = data::fetch(&db, &gt_int).await.expect("int >");
    assert_eq!(r.rows.len(), 2, "{:?}", r.rows);

    // Numeric column.
    let gt_num = TableQuery {
        filters: vec![Filter {
            column: "score".into(),
            op: FilterOp::Gt,
            value: Some("9".into()),
        }],
        ..table_query("f")
    };
    let r = data::fetch(&db, &gt_num).await.expect("numeric >");
    assert_eq!(r.rows.len(), 2, "{:?}", r.rows);

    // Text column with a numeric value must not raise 42883; non-numeric rows
    // drop out of the comparison.
    let gt_text = TableQuery {
        filters: vec![Filter {
            column: "name".into(),
            op: FilterOp::Gt,
            value: Some("5".into()),
        }],
        ..table_query("f")
    };
    let r = data::fetch(&db, &gt_text).await.expect("text > 5");
    assert_eq!(r.rows.len(), 0, "{:?}", r.rows);

    finish(admin, db, pool, name).await;
}

#[tokio::test]
async fn pg_ddl_covers_sequences_arrays_and_views() {
    let Ok(base) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_PG_URL is not set");
        return;
    };
    let name = "rdbstudio_pg_ddl_test";
    let (admin, db, pool) = scratch(&base, name).await;
    exec::execute(
        &db,
        "CREATE TABLE ser (id serial PRIMARY KEY, tags text[], n numeric(10,2))",
    )
    .await
    .expect("create ser");
    let ddl = design::ddl(&db, None, "ser").await.expect("table ddl");
    assert!(ddl.contains("CREATE SEQUENCE"), "{ddl}");
    assert!(ddl.contains("text[]"), "{ddl}");
    assert!(!ddl.contains("_text"), "{ddl}");

    exec::execute(&db, "CREATE VIEW v AS SELECT id, name FROM (SELECT 1 AS id, 'x'::text AS name) s")
        .await
        .expect("create view");
    let vddl = design::ddl(&db, None, "v").await.expect("view ddl");
    assert!(vddl.starts_with("CREATE VIEW"), "{vddl}");
    assert!(!vddl.contains("CREATE TABLE"), "{vddl}");

    finish(admin, db, pool, name).await;
}
