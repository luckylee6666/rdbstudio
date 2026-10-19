mod common;

use rdbstudio_lib::db::pool::DbPool;
use rdbstudio_lib::db::sync::SearchRequest;
use rdbstudio_lib::db::sync::{self, ConflictPolicy, SyncRequest};
use rdbstudio_lib::model::DriverKind;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::Row;

async fn sqlite_pool() -> DbPool {
    DbPool::Sqlite(
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("sqlite pool"),
    )
}

#[tokio::test]
async fn same_connection_copy_preserves_source_and_rejects_source_alias() {
    let db = sqlite_pool().await;
    let DbPool::Sqlite(pool) = &db else { unreachable!() };
    sqlx::raw_sql("CREATE TABLE source (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT, payload BLOB); INSERT INTO source VALUES (5, '中文', X'00FF80');")
        .execute(pool).await.unwrap();
    let request = SyncRequest {
        source_id: "same".into(), target_id: "same".into(),
        source_schema: None, target_schema: None,
        source_table: "source".into(), target_table: "source_copy".into(),
        compare_deletes: false,
    };
    let plan = sync::preview(&db, &db, request.clone()).await.unwrap();
    assert!(plan.data_supported && plan.structure.supported);
    sync::apply_structure(&db, &plan.structure).await.unwrap();
    let plan = sync::preview(&db, &db, request.clone()).await.unwrap();
    assert_eq!(sync::apply_data(&db, &plan, ConflictPolicy::InsertOnly).await.unwrap(), (1, 0, 0));
    for table in ["source", "source_copy"] {
        let row = sqlx::query(&format!("SELECT id, value, payload FROM {table}")).fetch_one(pool).await.unwrap();
        assert_eq!(row.get::<i64, _>(0), 5);
        assert_eq!(row.get::<String, _>(1), "中文");
        assert_eq!(row.get::<Vec<u8>, _>(2), vec![0, 255, 128]);
    }
    sqlx::query("INSERT INTO source_copy(value) VALUES ('next')").execute(pool).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT max(id) FROM source_copy").fetch_one(pool).await.unwrap(), 6);
    let alias = SyncRequest { target_table: "SOURCE".into(), ..request };
    assert!(sync::preview(&db, &db, alias).await.unwrap_err().to_string().contains("must differ"));
}

#[tokio::test]
async fn mirror_sync_across_distinct_sqlite_connections_preserves_exact_integer_and_text() {
    let source = sqlite_pool().await;
    let target = sqlite_pool().await;
    let source_pool = match &source {
        DbPool::Sqlite(p) => p,
        _ => unreachable!(),
    };
    let target_pool = match &target {
        DbPool::Sqlite(p) => p,
        _ => unreachable!(),
    };

    sqlx::query(
        "CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount TEXT NOT NULL, memo TEXT, payload BLOB)",
    )
    .execute(source_pool)
    .await
    .unwrap();
    sqlx::query("CREATE TABLE ledger_copy (id INTEGER PRIMARY KEY, amount TEXT NOT NULL, memo TEXT, payload BLOB)")
        .execute(target_pool)
        .await
        .unwrap();

    let exact_id = 9_007_199_254_740_993i64;
    let exact_amount = "12345678901234567890.12345678901234567890";
    let exact_payload = vec![0x00u8, 0xff, 0x10, 0x80];
    sqlx::query("INSERT INTO ledger (id, amount, memo, payload) VALUES (?, ?, ?, ?)")
        .bind(exact_id)
        .bind(exact_amount)
        .bind("source version")
        .bind(exact_payload.clone())
        .execute(source_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO ledger (id, amount, memo, payload) VALUES (?, ?, ?, ?)")
        .bind(2i64)
        .bind("0.00000000000000000001")
        .bind("new row")
        .bind(Option::<Vec<u8>>::None)
        .execute(source_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO ledger_copy (id, amount, memo, payload) VALUES (?, ?, ?, ?)")
        .bind(exact_id)
        .bind("0")
        .bind("stale target version")
        .bind(vec![0x01u8])
        .execute(target_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO ledger_copy (id, amount, memo, payload) VALUES (?, ?, ?, ?)")
        .bind(99i64)
        .bind("9.99")
        .bind("target only")
        .bind(vec![0x02u8])
        .execute(target_pool)
        .await
        .unwrap();

    let request = SyncRequest {
        source_id: "source-connection".into(),
        target_id: "target-connection".into(),
        source_schema: None,
        source_table: "ledger".into(),
        target_schema: None,
        target_table: "ledger_copy".into(),
        compare_deletes: true,
    };
    let preview = sync::preview(&source, &target, request).await.unwrap();
    assert_eq!(preview.source_driver, DriverKind::Sqlite);
    assert_eq!(preview.target_driver, DriverKind::Sqlite);
    assert!(preview.data_supported);
    assert!(preview.structure.supported);
    assert_eq!(preview.counts.inserts, 1);
    assert_eq!(preview.counts.updates, 1);
    assert_eq!(preview.counts.deletes, 1);

    let applied = sync::apply_data(&target, &preview, ConflictPolicy::Mirror)
        .await
        .unwrap();
    assert_eq!(applied, (1, 1, 1));

    let rows = sqlx::query("SELECT id, amount, memo, payload FROM ledger_copy ORDER BY id")
        .fetch_all(target_pool)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].try_get::<i64, _>(0).unwrap(), 2);
    assert_eq!(
        rows[0].try_get::<String, _>(1).unwrap(),
        "0.00000000000000000001"
    );
    assert_eq!(rows[0].try_get::<String, _>(2).unwrap(), "new row");
    assert_eq!(rows[0].try_get::<Option<Vec<u8>>, _>(3).unwrap(), None);
    assert_eq!(rows[1].try_get::<i64, _>(0).unwrap(), exact_id);
    assert_eq!(rows[1].try_get::<String, _>(1).unwrap(), exact_amount);
    assert_eq!(rows[1].try_get::<String, _>(2).unwrap(), "source version");
    assert_eq!(rows[1].try_get::<Vec<u8>, _>(3).unwrap(), exact_payload);
}

#[tokio::test]
async fn missing_target_table_has_reviewable_create_plan_and_can_transfer_data() {
    let source = sqlite_pool().await;
    let target = sqlite_pool().await;
    let source_pool = match &source {
        DbPool::Sqlite(p) => p,
        _ => unreachable!(),
    };
    let target_pool = match &target {
        DbPool::Sqlite(p) => p,
        _ => unreachable!(),
    };
    sqlx::query("CREATE TABLE source_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        .execute(source_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO source_table (id, value) VALUES (1, 'kept exact')")
        .execute(source_pool)
        .await
        .unwrap();
    let request = SyncRequest {
        source_id: "src".into(),
        target_id: "dst".into(),
        source_schema: None,
        source_table: "source_table".into(),
        target_schema: None,
        target_table: "new_table".into(),
        compare_deletes: false,
    };
    let preview = sync::preview(&source, &target, request).await.unwrap();
    assert!(!preview.structure.target_exists);
    assert!(preview.structure.supported);
    assert_eq!(preview.structure.statements.len(), 1);
    assert!(preview.structure.statements[0].starts_with("CREATE TABLE"));
    sync::apply_structure(&target, &preview.structure)
        .await
        .unwrap();

    // After DDL, a fresh preview binds synchronization to the new target shape.
    let refreshed = sync::preview(&source, &target, preview.request)
        .await
        .unwrap();
    let (inserted, updated, deleted) =
        sync::apply_data(&target, &refreshed, ConflictPolicy::InsertOnly)
            .await
            .unwrap();
    assert_eq!((inserted, updated, deleted), (1, 0, 0));
    let value: String = sqlx::query_scalar("SELECT value FROM new_table WHERE id = 1")
        .fetch_one(target_pool)
        .await
        .unwrap();
    assert_eq!(value, "kept exact");
}

#[tokio::test]
async fn global_search_uses_literal_patterns_and_returns_primary_key_location() {
    let db = sqlite_pool().await;
    let pool = match &db {
        DbPool::Sqlite(p) => p,
        _ => unreachable!(),
    };
    sqlx::query("CREATE TABLE contacts (id INTEGER PRIMARY KEY, note TEXT, secret BLOB)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO contacts (id, note, secret) VALUES (1, 'Needle %_ found', X'00FF')")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO contacts (id, note) VALUES (2, 'Needle XX found')")
        .execute(pool)
        .await
        .unwrap();

    let literal = SearchRequest {
        connection_id: "search-test".into(),
        schema: None,
        tables: vec![],
        text: "%_".into(),
        case_sensitive: false,
        limit: Some(50),
    };
    let result = sync::search(&db, &literal).await.unwrap();
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].table, "contacts");
    assert_eq!(result.hits[0].column, "note");
    assert_eq!(
        result.hits[0].primary_key,
        vec![("id".into(), serde_json::json!(1))]
    );

    let case_sensitive = SearchRequest {
        text: "needle".into(),
        case_sensitive: true,
        ..literal
    };
    assert!(sync::search(&db, &case_sensitive)
        .await
        .unwrap()
        .hits
        .is_empty());
}

#[tokio::test]
async fn sync_aborts_when_a_target_row_changes_after_preview() {
    let source = crate::common::mem_pool().await;
    let target = crate::common::mem_pool().await;
    for pool in [&source, &target] {
        rdbstudio_lib::db::exec::execute(
            pool,
            "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)",
        )
        .await
        .unwrap();
    }
    rdbstudio_lib::db::exec::execute(&source, "INSERT INTO items VALUES(1,'source'),(2,'insert')")
        .await
        .unwrap();
    rdbstudio_lib::db::exec::execute(&target, "INSERT INTO items VALUES(1,'old')")
        .await
        .unwrap();
    let request = SyncRequest {
        source_id: "s".into(),
        target_id: "t".into(),
        source_schema: None,
        target_schema: None,
        source_table: "items".into(),
        target_table: "items".into(),
        compare_deletes: false,
    };
    let plan = sync::preview(&source, &target, request).await.unwrap();
    rdbstudio_lib::db::exec::execute(
        &target,
        "UPDATE items SET value='concurrent edit' WHERE id=1",
    )
    .await
    .unwrap();
    assert!(sync::apply_data(&target, &plan, ConflictPolicy::Overwrite)
        .await
        .is_err());
    let rows = rdbstudio_lib::db::exec::execute(&target, "SELECT id,value FROM items")
        .await
        .unwrap()
        .rows;
    assert_eq!(
        rows,
        vec![vec![
            serde_json::json!(1),
            serde_json::json!("concurrent edit")
        ]]
    );
}

#[tokio::test]
async fn sqlite_transfer_preserves_autoincrement_and_generated_ids() {
    let source = sqlite_pool().await;
    let target = sqlite_pool().await;
    rdbstudio_lib::db::exec::execute(
        &source,
        "CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT)",
    )
    .await
    .unwrap();
    rdbstudio_lib::db::exec::execute(&source, "INSERT INTO items(id,value) VALUES(30,'copied')")
        .await
        .unwrap();
    let request = SyncRequest {
        source_id: "src".into(),
        target_id: "dst".into(),
        source_schema: None,
        target_schema: None,
        source_table: "items".into(),
        target_table: "items".into(),
        compare_deletes: false,
    };
    let plan = sync::preview(&source, &target, request.clone())
        .await
        .unwrap();
    assert!(plan.structure.supported, "{:?}", plan.structure.reason);
    sync::apply_structure(&target, &plan.structure)
        .await
        .unwrap();
    let plan = sync::preview(&source, &target, request).await.unwrap();
    assert!(plan.data_supported, "{:?}", plan.data_reason);
    sync::apply_data(&target, &plan, ConflictPolicy::InsertOnly)
        .await
        .unwrap();
    rdbstudio_lib::db::exec::execute(&target, "INSERT INTO items(value) VALUES('next')")
        .await
        .unwrap();
    assert_eq!(
        rdbstudio_lib::db::exec::execute(&target, "SELECT MAX(id) AS n FROM items")
            .await
            .unwrap()
            .rows[0][0],
        31
    );
}

#[tokio::test]
async fn new_table_copy_recreates_indexes_and_reports_uncopied_features() {
    let source = sqlite_pool().await;
    let target = sqlite_pool().await;
    let (DbPool::Sqlite(source_pool), DbPool::Sqlite(target_pool)) = (&source, &target) else {
        unreachable!()
    };
    sqlx::raw_sql(
        "CREATE TABLE parent (id INTEGER PRIMARY KEY);
         CREATE TABLE child (
           id INTEGER PRIMARY KEY,
           parent_id INTEGER REFERENCES parent(id),
           email TEXT NOT NULL UNIQUE,
           city TEXT
         );
         CREATE INDEX child_city ON child(city);
         CREATE TABLE audit (n INTEGER);
         CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO audit VALUES (NEW.id); END;
         INSERT INTO parent VALUES (1);
         INSERT INTO child VALUES (1, 1, 'a@example.test', 'Berlin'), (2, 1, 'b@example.test', 'Tokyo');",
    )
    .execute(source_pool)
    .await
    .unwrap();
    let request = SyncRequest {
        source_id: "src".into(),
        target_id: "dst".into(),
        source_schema: None,
        source_table: "child".into(),
        target_schema: None,
        target_table: "child_copy".into(),
        compare_deletes: false,
    };
    let preview = sync::preview(&source, &target, request).await.unwrap();
    // Trigger and FK are reported for review, not treated as blockers.
    assert!(preview.structure.supported, "{:?}", preview.structure.reason);
    assert!(preview.data_supported, "{:?}", preview.data_reason);
    let kinds: Vec<&str> = preview.structure.changes.iter().map(|c| c.kind.as_str()).collect();
    assert!(kinds.contains(&"not_copied"), "{kinds:?}");
    assert!(kinds.contains(&"foreign_keys_not_copied"), "{kinds:?}");
    assert_eq!(kinds.iter().filter(|k| **k == "create_index").count(), 2, "{kinds:?}");
    assert!(preview.structure.statements[0].starts_with("CREATE TABLE"));
    assert!(preview.structure.statements.iter().any(|s| s.starts_with("CREATE UNIQUE INDEX")));

    sync::apply_structure(&target, &preview.structure).await.unwrap();
    let refreshed = sync::preview(&source, &target, preview.request).await.unwrap();
    let (inserted, _, _) = sync::apply_data(&target, &refreshed, ConflictPolicy::InsertOnly)
        .await
        .unwrap();
    assert_eq!(inserted, 2);
    let unique_indexes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pragma_index_list('child_copy') WHERE \"unique\" = 1",
    )
    .fetch_one(target_pool)
    .await
    .unwrap();
    assert_eq!(unique_indexes, 1);
    let duplicate = sqlx::query("INSERT INTO child_copy (id, email) VALUES (3, 'a@example.test')")
        .execute(target_pool)
        .await;
    assert!(duplicate.is_err(), "copied UNIQUE index must be enforced");
}
