mod common;

use rdbstudio_lib::db::meta;

#[tokio::test]
async fn list_tables_returns_seeded_users() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let tables = meta::list_tables(&pool, None).await.expect("list_tables");
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert!(
        names.contains(&"users"),
        "expected 'users' in {:?}",
        names
    );
    let users = tables.iter().find(|t| t.name == "users").unwrap();
    assert_eq!(users.kind, "table");
}

#[tokio::test]
async fn list_columns_returns_four_columns_with_nullable_and_pk() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let cols = meta::list_columns(&pool, None, "users")
        .await
        .expect("list_columns");
    assert_eq!(cols.len(), 4, "got {:?}", cols);

    let id = cols.iter().find(|c| c.name == "id").expect("id col");
    assert!(id.is_primary_key, "id should be PK");

    let name = cols.iter().find(|c| c.name == "name").expect("name col");
    assert!(!name.nullable, "name should be NOT NULL");
    assert!(!name.is_primary_key);

    let age = cols.iter().find(|c| c.name == "age").expect("age col");
    assert!(age.nullable, "age should be nullable");

    let email = cols.iter().find(|c| c.name == "email").expect("email col");
    assert!(email.nullable, "email should be nullable");
}

#[tokio::test]
async fn list_databases_returns_main_for_sqlite() {
    let pool = common::mem_pool().await;
    let dbs = meta::list_databases(&pool).await.expect("list_databases");
    assert_eq!(dbs, vec!["main".to_string()]);
}

#[tokio::test]
async fn server_version_starts_with_sqlite() {
    let pool = common::mem_pool().await;
    let v = meta::server_version(&pool).await.expect("server_version");
    assert!(v.starts_with("SQLite"), "unexpected version string: {}", v);
}

#[tokio::test]
async fn star_width_counts_generated_columns_and_uses_the_requested_schema() {
    use rdbstudio_lib::db::pool::DbPool;
    let pool = common::mem_pool().await;
    let DbPool::Sqlite(sqlite) = &pool else {
        unreachable!()
    };
    sqlx::raw_sql(
        "CREATE TABLE cells(x INTEGER, doubled INTEGER AS (x*2));
         CREATE TEMP TABLE cells(x INTEGER);
         CREATE VIEW measured AS SELECT x, doubled FROM main.cells;",
    )
    .execute(sqlite)
    .await
    .unwrap();
    assert_eq!(
        meta::star_width(&pool, Some("main"), "cells")
            .await
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        meta::star_width(&pool, None, "cells").await.unwrap(),
        Some(1)
    );
    assert_eq!(
        meta::star_width(&pool, Some("main"), "measured")
            .await
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        meta::star_width(&pool, None, "missing").await.unwrap(),
        None
    );
}
