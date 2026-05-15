mod common;

use rdbstudio_lib::db::data::{
    self, Edit, EditBatch, Filter, FilterOp, OrderBy, SortDir, TableQuery,
};
use rdbstudio_lib::model::DriverKind;
use serde_json::json;

fn tq(table: &str) -> TableQuery {
    TableQuery {
        schema: None,
        table: table.into(),
        limit: 100,
        offset: 0,
        order_by: None,
        filters: vec![],
        where_raw: None,
    }
}

#[tokio::test]
async fn fetch_with_eq_filter_returns_one_row() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let mut q = tq("users");
    q.filters = vec![Filter {
        column: "name".into(),
        op: FilterOp::Eq,
        value: Some("Alice".into()),
    }];
    let r = data::fetch(&pool, &q).await.expect("fetch");
    assert_eq!(r.rows.len(), 1);
    // find the name column
    let name_idx = r
        .columns
        .iter()
        .position(|c| c.name == "name")
        .expect("name col");
    assert_eq!(r.rows[0][name_idx].as_str(), Some("Alice"));
}

#[tokio::test]
async fn fetch_order_by_desc_sorts_by_id() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let mut q = tq("users");
    q.order_by = Some(OrderBy {
        column: "id".into(),
        direction: SortDir::Desc,
    });
    let r = data::fetch(&pool, &q).await.expect("fetch");
    assert_eq!(r.rows.len(), 3);
    let id_idx = r
        .columns
        .iter()
        .position(|c| c.name == "id")
        .expect("id col");
    let ids: Vec<i64> = r
        .rows
        .iter()
        .map(|row| row[id_idx].as_i64().expect("i64 id"))
        .collect();
    assert_eq!(ids, vec![3, 2, 1]);
}

#[tokio::test]
async fn count_returns_total_rows() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let q = tq("users");
    let n = data::count(&pool, &q).await.expect("count");
    assert_eq!(n, 3);
}

#[tokio::test]
async fn count_with_filter() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let mut q = tq("users");
    q.filters = vec![Filter {
        column: "name".into(),
        op: FilterOp::Eq,
        value: Some("Bob".into()),
    }];
    let n = data::count(&pool, &q).await.expect("count");
    assert_eq!(n, 1);
}

#[tokio::test]
async fn apply_edits_insert_update_delete() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    // Insert a new user
    let batch = EditBatch {
        schema: None,
        table: "users".into(),
        edits: vec![
            Edit::Insert {
                values: vec![
                    ("id".into(), json!(10)),
                    ("name".into(), json!("Dave")),
                    ("age".into(), json!(40)),
                    ("email".into(), json!("dave@example.com")),
                ],
            },
            Edit::Update {
                pk: vec![("id".into(), json!(1))],
                set: vec![("age".into(), json!(31))],
            },
            Edit::Delete {
                pk: vec![("id".into(), json!(2))],
            },
        ],
    };
    let r = data::apply_edits(&pool, &batch)
        .await
        .expect("apply_edits");
    assert!(r.ok, "edits should succeed: {:?}", r);
    assert_eq!(r.applied, 3, "total applied rows across 3 edits");

    // verify result
    let q = tq("users");
    let total = data::count(&pool, &q).await.expect("count");
    assert_eq!(total, 3, "3 seeded -1 deleted +1 inserted = 3");
}

#[tokio::test]
async fn preview_edit_sql_update_escapes_quotes() {
    let edit = Edit::Update {
        pk: vec![("id".into(), json!(1))],
        set: vec![("name".into(), json!("O'Brien"))],
    };
    let sql = data::preview_edit_sql(DriverKind::Sqlite, None, "users", &edit);
    // Should inline "O''Brien" (single quote doubled)
    assert!(
        sql.contains("'O''Brien'"),
        "expected escaped literal in: {}",
        sql
    );
    // Should reference the users table quoted
    assert!(sql.starts_with("UPDATE \"users\" SET"), "got: {}", sql);
    // No placeholders left
    assert!(!sql.contains('?'), "placeholder leaked: {}", sql);
}

#[tokio::test]
async fn preview_edit_sql_postgres_numbered_placeholders_replaced() {
    let edit = Edit::Update {
        pk: vec![("id".into(), json!(1))],
        set: vec![
            ("name".into(), json!("Al")),
            ("age".into(), json!(42)),
        ],
    };
    let sql = data::preview_edit_sql(DriverKind::Postgres, Some("public"), "users", &edit);
    assert!(sql.contains("'Al'"), "got: {}", sql);
    assert!(sql.contains("42"), "got: {}", sql);
    assert!(!sql.contains("$1"), "placeholder leaked: {}", sql);
    assert!(!sql.contains("$2"), "placeholder leaked: {}", sql);
}
