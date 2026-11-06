mod common;

use rdbstudio_lib::db::datagen::{self, ColumnGeneratorConfig, DataGenOptions, DataGenRule};
use rdbstudio_lib::db::pool::DbPool;

fn column(name: &str, rule: DataGenRule) -> ColumnGeneratorConfig {
    ColumnGeneratorConfig {
        column: name.into(),
        rule,
        null_percent: 0,
        start: None,
        step: None,
        min: None,
        max: None,
        values: None,
    }
}

fn options(table: &str) -> DataGenOptions {
    DataGenOptions {
        schema: None,
        table: table.into(),
        row_count: 100_000,
        truncate_first: false,
        seed: Some(42),
        columns: vec![column("email", DataGenRule::Email)],
    }
}

#[tokio::test]
async fn full_size_email_batch_satisfies_unique_constraint() {
    let db = common::mem_pool().await;
    let DbPool::Sqlite(pool) = &db else {
        unreachable!()
    };
    sqlx::query("CREATE TABLE users (email TEXT NOT NULL UNIQUE)")
        .execute(pool)
        .await
        .unwrap();
    let report = datagen::generate_table_data(&db, &options("users"))
        .await
        .unwrap();
    assert_eq!(report.rows_inserted, 100_000);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(count, 100_000);
}

#[tokio::test]
async fn failed_later_batch_rolls_back_generated_rows_and_restores_cleared_data() {
    let db = common::mem_pool().await;
    let DbPool::Sqlite(pool) = &db else {
        unreachable!()
    };
    sqlx::query("CREATE TABLE users (id INTEGER PRIMARY KEY CHECK (id < 300), email TEXT)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users VALUES (0, 'original')")
        .execute(pool)
        .await
        .unwrap();
    let mut opts = options("users");
    opts.row_count = 501;
    opts.truncate_first = true;
    opts.columns.insert(0, column("id", DataGenRule::Sequence));
    assert!(datagen::generate_table_data(&db, &opts).await.is_err());
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, email FROM users")
        .fetch_all(pool)
        .await
        .unwrap();
    assert_eq!(rows, vec![(0, "original".into())]);
}

#[tokio::test]
async fn postgres_clearing_refuses_to_cascade_into_referencing_tables() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_PG_URL is not set");
        return;
    };
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let schema = format!("datagen_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema};
         CREATE TABLE {schema}.users (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email TEXT);
         CREATE TABLE {schema}.orders (user_id INTEGER REFERENCES {schema}.users(id));
         INSERT INTO {schema}.users (email) VALUES ('original');
         INSERT INTO {schema}.orders VALUES (1)"
    )).execute(&pool).await.unwrap();
    let db = DbPool::Postgres(pool.clone());
    let mut opts = options("users");
    opts.schema = Some(schema.clone());
    opts.row_count = 2;
    opts.truncate_first = true;
    let result = datagen::generate_table_data(&db, &opts).await;
    let users: Vec<(i32, String)> =
        sqlx::query_as(&format!("SELECT id, email FROM {schema}.users"))
            .fetch_all(&pool)
            .await
            .unwrap();
    let orders: Vec<i32> = sqlx::query_scalar(&format!("SELECT user_id FROM {schema}.orders"))
        .fetch_all(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    assert!(
        result.is_err(),
        "clearing one table must not clear referencing tables"
    );
    assert_eq!(users, vec![(1, "original".into())]);
    assert_eq!(orders, vec![1]);
}

#[tokio::test]
async fn postgres_clearing_rolls_back_on_error_and_restarts_identity_on_success() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_PG_URL is not set");
        return;
    };
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let schema = format!("datagen_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema};
         CREATE TABLE {schema}.users (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (id < 300), email TEXT);
         INSERT INTO {schema}.users (email) VALUES ('original')"
    )).execute(&pool).await.unwrap();
    let db = DbPool::Postgres(pool.clone());
    let mut opts = options("users");
    opts.schema = Some(schema.clone());
    opts.row_count = 501;
    opts.truncate_first = true;
    assert!(datagen::generate_table_data(&db, &opts).await.is_err());
    let rows: Vec<(i32, String)> = sqlx::query_as(&format!("SELECT id, email FROM {schema}.users"))
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(rows, vec![(1, "original".into())]);
    let next: i32 = sqlx::query_scalar(&format!(
        "INSERT INTO {schema}.users (email) VALUES ('after') RETURNING id"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        next, 2,
        "failed truncation must restore the identity sequence"
    );
    opts.row_count = 3;
    let report = datagen::generate_table_data(&db, &opts).await.unwrap();
    assert_eq!(report.rows_inserted, 3);
    let ids: Vec<i32> = sqlx::query_scalar(&format!("SELECT id FROM {schema}.users ORDER BY id"))
        .fetch_all(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    assert_eq!(ids, vec![1, 2, 3]);
}
