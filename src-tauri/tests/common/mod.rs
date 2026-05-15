//! Shared helpers for integration tests.
//!
//! Uses a max_connections=1 in-memory SQLite pool so the schema survives
//! across multiple acquires (each in-memory connection is otherwise isolated).

use rdbstudio_lib::db::pool::DbPool;
use sqlx::sqlite::SqlitePoolOptions;

#[allow(dead_code)]
pub async fn mem_pool() -> DbPool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect sqlite::memory:");
    DbPool::Sqlite(pool)
}

#[allow(dead_code)]
pub async fn seed_users(pool: &DbPool) {
    let sqlite = match pool {
        DbPool::Sqlite(p) => p,
        _ => panic!("seed_users requires a SQLite pool"),
    };
    sqlx::query(
        "CREATE TABLE users (\
            id INTEGER PRIMARY KEY, \
            name TEXT NOT NULL, \
            age INTEGER, \
            email TEXT\
        )",
    )
    .execute(sqlite)
    .await
    .expect("create users");

    for (id, name, age, email) in [
        (1i64, "Alice", Some(30i64), Some("alice@example.com")),
        (2, "Bob", Some(25), None),
        (3, "Carol", None, Some("carol@example.com")),
    ] {
        sqlx::query("INSERT INTO users (id, name, age, email) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(name)
            .bind(age)
            .bind(email)
            .execute(sqlite)
            .await
            .expect("insert user");
    }
}
