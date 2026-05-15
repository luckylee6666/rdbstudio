//! Full-stack smoke test on a real on-disk SQLite database.
//!
//! Drives the same code paths the Tauri commands invoke, in the order a user
//! would: connect → list_tables/columns → execute query → fetch_table_data
//! → apply_edits → describe_table / show_ddl → export_table → import_csv
//! → generate_alter_ddl + apply_alter_ddl. If anything regresses end-to-end,
//! this test catches it without needing the GUI.

use rdbstudio_lib::db::{
    self,
    alter::{self, ColumnEdit, DesignerChange},
    data::{self, Edit, EditBatch, FilterOp, TableQuery},
    design,
    exec::{self, is_readonly},
    io::{self, ExportFormat, ExportOptions, ImportCsvOptions, ImportMode},
    meta,
    pool::DbPool,
};
use rdbstudio_lib::model::{ConnectionConfig, DriverKind};
use serde_json::{json, Value};
use tempfile::TempDir;

fn cfg_for(path: &std::path::Path) -> ConnectionConfig {
    ConnectionConfig {
        id: "test".into(),
        name: "test".into(),
        driver: DriverKind::Sqlite,
        host: None,
        port: None,
        database: None,
        username: None,
        file_path: Some(path.to_string_lossy().into()),
        color: None,
        pinned: false,
        group: None,
        password: None,
    }
}

async fn setup() -> (TempDir, DbPool) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("e2e.sqlite");
    let cfg = cfg_for(&db_path);
    let url = db::build_url(&cfg).expect("build url");
    let pool = DbPool::connect(DriverKind::Sqlite, &url)
        .await
        .expect("open sqlite file");

    // Bootstrap a small schema. Done via raw SQL through the same
    // execute path the UI uses.
    exec::execute(
        &pool,
        "CREATE TABLE users (\
            id INTEGER PRIMARY KEY, \
            name TEXT NOT NULL, \
            age INTEGER, \
            email TEXT\
         )",
    )
    .await
    .expect("create users");
    exec::execute(
        &pool,
        "INSERT INTO users (id, name, age, email) VALUES \
            (1, 'Alice', 30, 'alice@example.com'), \
            (2, 'Bob', 25, NULL), \
            (3, 'Carol', NULL, 'carol@example.com')",
    )
    .await
    .expect("seed users");

    (dir, pool)
}

#[tokio::test]
async fn server_version_reports_sqlite() {
    let (_dir, pool) = setup().await;
    let v = meta::server_version(&pool).await.expect("version");
    assert!(v.starts_with("SQLite "), "expected SQLite version, got {v}");
}

#[tokio::test]
async fn list_tables_lists_users_with_metadata() {
    let (_dir, pool) = setup().await;
    let tables = meta::list_tables(&pool, None).await.expect("list_tables");
    let users = tables
        .iter()
        .find(|e| e.name == "users")
        .expect("users table");
    assert_eq!(users.kind, "table");

    let cols = meta::list_columns(&pool, None, "users")
        .await
        .expect("list_columns");
    assert_eq!(cols.len(), 4);
    let id = cols.iter().find(|c| c.name == "id").unwrap();
    assert!(id.is_primary_key, "id should be the PK");
    let name = cols.iter().find(|c| c.name == "name").unwrap();
    assert!(!name.nullable, "name was declared NOT NULL");
}

#[tokio::test]
async fn execute_count_returns_integer_not_null() {
    // Regression: SQLite's `count(*)` column has empty/NULL type info; the
    // decoder must still surface the integer value, not Json::Null.
    let (_dir, pool) = setup().await;
    let r = exec::execute(&pool, "SELECT count(*) AS n FROM users")
        .await
        .expect("execute count");
    assert_eq!(r.columns.len(), 1);
    assert_eq!(r.rows.len(), 1);
    let n = &r.rows[0][0];
    assert_eq!(
        n.as_i64(),
        Some(3),
        "expected count=3 but got {:?}",
        n
    );
}

#[tokio::test]
async fn is_readonly_routes_select_to_decoder() {
    assert!(is_readonly("SELECT * FROM users"));
    assert!(!is_readonly("INSERT INTO users (id) VALUES (99)"));
}

#[tokio::test]
async fn fetch_with_filter_and_order_returns_subset() {
    let (_dir, pool) = setup().await;
    let q = TableQuery {
        schema: None,
        table: "users".into(),
        limit: 10,
        offset: 0,
        order_by: Some(data::OrderBy {
            column: "id".into(),
            direction: data::SortDir::Desc,
        }),
        filters: vec![data::Filter {
            column: "age".into(),
            op: FilterOp::Gte,
            value: Some("25".into()),
        }],
        where_raw: None,
    };
    let r = data::fetch(&pool, &q).await.expect("fetch");
    assert_eq!(r.rows.len(), 2, "Alice + Bob match age >= 25");
    let first_id = r.rows[0][0].as_i64();
    assert_eq!(first_id, Some(2), "DESC order should put Bob (id=2) first");

    let n = data::count(&pool, &q).await.expect("count");
    assert_eq!(n, 2);
}

#[tokio::test]
async fn apply_edits_inserts_updates_and_deletes_then_persists() {
    let (_dir, pool) = setup().await;
    let batch = EditBatch {
        schema: None,
        table: "users".into(),
        edits: vec![
            Edit::Insert {
                values: vec![
                    ("id".into(), json!(4)),
                    ("name".into(), json!("Dave")),
                    ("age".into(), json!(40)),
                    ("email".into(), Value::Null),
                ],
            },
            Edit::Update {
                pk: vec![("id".into(), json!(2))],
                set: vec![("email".into(), json!("bob@example.com"))],
            },
            Edit::Delete {
                pk: vec![("id".into(), json!(3))],
            },
        ],
    };
    let r = data::apply_edits(&pool, &batch).await.expect("apply_edits");
    assert!(r.ok, "{:?}", r.error);
    assert_eq!(r.applied, 3);

    // Verify persisted state.
    let after = exec::execute(&pool, "SELECT id, name, email FROM users ORDER BY id")
        .await
        .expect("select after edits");
    let ids: Vec<i64> = after
        .rows
        .iter()
        .map(|r| r[0].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![1, 2, 4], "Carol gone, Dave added");
    let bob = after
        .rows
        .iter()
        .find(|r| r[0].as_i64() == Some(2))
        .unwrap();
    assert_eq!(bob[2].as_str(), Some("bob@example.com"));
}

#[tokio::test]
async fn describe_and_show_ddl_round_trip() {
    let (_dir, pool) = setup().await;
    let d = design::describe(&pool, None, "users")
        .await
        .expect("describe");
    assert_eq!(d.name, "users");
    assert_eq!(d.primary_key, vec!["id".to_string()]);
    assert!(d.columns.iter().any(|c| c.name == "name" && !c.nullable));

    let ddl = design::ddl(&pool, None, "users").await.expect("ddl");
    assert!(ddl.to_uppercase().contains("CREATE TABLE"));
    assert!(ddl.contains("users"));
    assert!(ddl.trim_end().ends_with(';'));
}

#[tokio::test]
async fn export_csv_then_import_csv_round_trip() {
    let (dir, pool) = setup().await;
    let csv_path = dir.path().join("users.csv");
    let report = io::export_table(
        &pool,
        None,
        "users",
        &ExportOptions {
            format: ExportFormat::Csv,
            path: csv_path.to_string_lossy().into(),
            delimiter: ',',
            include_header: true,
            quote_all: false,
            batch_size: 100,
        },
    )
    .await
    .expect("export csv");
    assert_eq!(report.rows_written, 3);
    assert!(csv_path.exists());
    let raw = std::fs::read_to_string(&csv_path).unwrap();
    let header = raw.lines().next().expect("header line");
    let header_cols: Vec<&str> = header.split(',').collect();
    for col in ["id", "name", "age", "email"] {
        assert!(
            header_cols.contains(&col),
            "expected '{col}' in CSV header '{header}'"
        );
    }
    let body_lines = raw.lines().skip(1).filter(|l| !l.is_empty()).count();
    assert_eq!(body_lines, 3, "expected 3 data rows in CSV, got: {raw:?}");

    // Now import the same CSV into a fresh sister table to prove parity.
    exec::execute(
        &pool,
        "CREATE TABLE users_copy (\
            id INTEGER PRIMARY KEY, name TEXT, age INTEGER, email TEXT\
         )",
    )
    .await
    .expect("create users_copy");

    let r = io::import_csv(
        &pool,
        &ImportCsvOptions {
            path: csv_path.to_string_lossy().into(),
            schema: None,
            table: "users_copy".into(),
            delimiter: ',',
            has_header: true,
            mode: ImportMode::Append,
            column_map: None,
        },
    )
    .await
    .expect("import csv");
    assert_eq!(r.rows_inserted, 3, "errors: {:?}", r.errors);
    assert!(r.errors.is_empty());

    let after = exec::execute(&pool, "SELECT count(*) FROM users_copy")
        .await
        .expect("count copy");
    assert_eq!(after.rows[0][0].as_i64(), Some(3));
}

#[tokio::test]
async fn alter_ddl_adds_column_and_applies_cleanly() {
    let (_dir, pool) = setup().await;

    // Plan adding a `bio` column without changing existing ones.
    let mut edits: Vec<ColumnEdit> = vec![
        ColumnEdit {
            original_name: Some("id".into()),
            name: "id".into(),
            data_type: "INTEGER".into(),
            nullable: false,
            default: None,
            is_primary_key: true,
        },
        ColumnEdit {
            original_name: Some("name".into()),
            name: "name".into(),
            data_type: "TEXT".into(),
            nullable: false,
            default: None,
            is_primary_key: false,
        },
        ColumnEdit {
            original_name: Some("age".into()),
            name: "age".into(),
            data_type: "INTEGER".into(),
            nullable: true,
            default: None,
            is_primary_key: false,
        },
        ColumnEdit {
            original_name: Some("email".into()),
            name: "email".into(),
            data_type: "TEXT".into(),
            nullable: true,
            default: None,
            is_primary_key: false,
        },
    ];
    edits.push(ColumnEdit {
        original_name: None,
        name: "bio".into(),
        data_type: "TEXT".into(),
        nullable: true,
        default: None,
        is_primary_key: false,
    });

    let plan = alter::generate_alter(&pool, None, "users", &DesignerChange { columns: edits })
        .await
        .expect("plan alter");
    assert!(
        !plan.statements.is_empty(),
        "expected at least one ALTER statement"
    );
    let executed = alter::apply_statements(&pool, &plan.statements)
        .await
        .expect("apply alter");
    assert_eq!(executed.len(), plan.statements.len());

    // Confirm the column landed.
    let cols = meta::list_columns(&pool, None, "users")
        .await
        .expect("list_columns after alter");
    assert!(
        cols.iter().any(|c| c.name == "bio"),
        "bio column should exist after ALTER, got {:?}",
        cols.iter().map(|c| &c.name).collect::<Vec<_>>()
    );
}
