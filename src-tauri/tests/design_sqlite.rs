mod common;

use rdbstudio_lib::db::design;

#[tokio::test]
async fn describe_returns_columns_with_pk() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let desc = design::describe(&pool, None, "users")
        .await
        .expect("describe");
    assert_eq!(desc.name, "users");
    assert_eq!(desc.columns.len(), 4, "got {:?}", desc.columns);

    let id_col = desc
        .columns
        .iter()
        .find(|c| c.name == "id")
        .expect("id col");
    assert!(id_col.is_primary_key);
    assert_eq!(desc.primary_key, vec!["id".to_string()]);

    // no FK were defined for users
    assert!(desc.foreign_keys.is_empty());
}

#[tokio::test]
async fn describe_returns_fk_when_defined() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    // create a posts table with a FK -> users.id
    let sqlite = match &pool {
        rdbstudio_lib::db::pool::DbPool::Sqlite(p) => p,
        _ => unreachable!(),
    };
    sqlx::query(
        "CREATE TABLE posts (\
            id INTEGER PRIMARY KEY, \
            user_id INTEGER NOT NULL, \
            title TEXT, \
            FOREIGN KEY (user_id) REFERENCES users(id)\
        )",
    )
    .execute(sqlite)
    .await
    .expect("create posts");

    let desc = design::describe(&pool, None, "posts")
        .await
        .expect("describe posts");
    assert!(
        !desc.foreign_keys.is_empty(),
        "expected at least one FK, got {:?}",
        desc
    );
    let fk = &desc.foreign_keys[0];
    assert_eq!(fk.referenced_table, "users");
    assert_eq!(fk.referenced_columns, vec!["id".to_string()]);
    assert_eq!(fk.columns, vec!["user_id".to_string()]);
}

#[tokio::test]
async fn ddl_returns_create_table_terminated_with_semicolon() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let ddl = design::ddl(&pool, None, "users").await.expect("ddl");
    let up = ddl.to_uppercase();
    assert!(up.contains("CREATE TABLE"), "got: {}", ddl);
    assert!(ddl.contains("users"), "got: {}", ddl);
    assert!(ddl.trim_end().ends_with(';'), "no trailing ;: {}", ddl);
}
