use rdbstudio_lib::db::pool::DbPool;
use rdbstudio_lib::db::sync::{self, ConflictPolicy, SyncRequest};
use sqlx::Row;

#[tokio::test]
async fn postgres_sync_preserves_numeric_null_binary_and_primary_key_conflicts() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_PG_URL is not set");
        return;
    };
    let pool = sqlx::PgPool::connect(&url)
        .await
        .expect("connect PostgreSQL");
    let src_name = format!("rdb_sync_src_{}", uuid::Uuid::new_v4().simple());
    let dst_name = format!("rdb_sync_dst_{}", uuid::Uuid::new_v4().simple());
    let copy_name = format!("rdb_sync_copy_{}", uuid::Uuid::new_v4().simple());
    let create = |name: &str| {
        format!(
            "CREATE TABLE public.{name} (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, amount NUMERIC(20,8) NOT NULL, note TEXT, payload BYTEA)"
        )
    };
    sqlx::raw_sql(&create(&src_name))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(&create(&dst_name))
        .execute(&pool)
        .await
        .unwrap();
    let exact_id = 9_007_199_254_740_993i64;
    sqlx::raw_sql(&format!(
        "INSERT INTO public.{src_name} OVERRIDING SYSTEM VALUE VALUES ({exact_id}, 123456789012.12345678, NULL, decode('00ff1080', 'hex'))"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(&format!(
        "INSERT INTO public.{dst_name} OVERRIDING SYSTEM VALUE VALUES ({exact_id}, 0, 'stale', decode('01', 'hex'))"
    ))
    .execute(&pool)
    .await
    .unwrap();

    let db = DbPool::Postgres(pool.clone());
    let request = SyncRequest {
        source_id: "pg-source".into(),
        target_id: "pg-target".into(),
        source_schema: Some("public".into()),
        source_table: src_name.clone(),
        target_schema: Some("public".into()),
        target_table: dst_name.clone(),
        compare_deletes: false,
    };
    let preview = sync::preview(&db, &db, request.clone()).await.unwrap();
    assert!(preview.data_supported, "{:?}", preview.data_reason);
    assert_eq!(preview.counts.inserts, 0);
    assert_eq!(preview.counts.updates, 1);
    sync::apply_data(&db, &preview, ConflictPolicy::Overwrite)
        .await
        .unwrap();
    let row = sqlx::query(&format!(
        "SELECT id, amount::text AS amount, note, payload FROM public.{dst_name}"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.try_get::<i64, _>("id").unwrap(), exact_id);
    assert_eq!(
        row.try_get::<String, _>("amount").unwrap(),
        "123456789012.12345678"
    );
    assert_eq!(row.try_get::<Option<String>, _>("note").unwrap(), None);
    assert_eq!(
        row.try_get::<Vec<u8>, _>("payload").unwrap(),
        vec![0x00, 0xff, 0x10, 0x80]
    );

    // Missing target structure is reviewed as DDL, then a fresh data preview
    // is required before transfer.
    let mut copy_request = request;
    copy_request.target_table = copy_name.clone();
    let structure_preview = sync::preview(&db, &db, copy_request.clone()).await.unwrap();
    assert!(
        structure_preview.structure.supported,
        "{:?}",
        structure_preview.structure.reason
    );
    assert!(!structure_preview.structure.target_exists);
    assert_eq!(structure_preview.structure.statements.len(), 1);
    sync::apply_structure(&db, &structure_preview.structure)
        .await
        .unwrap();
    let data_preview = sync::preview(&db, &db, copy_request).await.unwrap();
    assert!(
        data_preview.data_supported,
        "{:?}",
        data_preview.data_reason
    );
    assert_eq!(data_preview.counts.inserts, 1);
    sync::apply_data(&db, &data_preview, ConflictPolicy::InsertOnly)
        .await
        .unwrap();
    let copied = sqlx::query(&format!(
        "SELECT id, amount::text AS amount, note, payload FROM public.{copy_name}"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(copied.try_get::<i64, _>("id").unwrap(), exact_id);
    assert_eq!(
        copied.try_get::<String, _>("amount").unwrap(),
        "123456789012.12345678"
    );
    assert_eq!(copied.try_get::<Option<String>, _>("note").unwrap(), None);
    assert_eq!(
        copied.try_get::<Vec<u8>, _>("payload").unwrap(),
        vec![0x00, 0xff, 0x10, 0x80]
    );

    let next: i64 = sqlx::query_scalar(&format!(
        "INSERT INTO public.{copy_name} (amount) VALUES(1) RETURNING id"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        next > exact_id,
        "the target identity sequence must advance past copied IDs"
    );
    // A schema/PK mismatch is reported before writes; it cannot turn a source
    // key collision into an insert that overwrites a different row.
    let unsafe_name = format!("rdb_sync_bad_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(&format!("CREATE TABLE public.{unsafe_name} (id TEXT PRIMARY KEY, amount TEXT, note TEXT, payload BYTEA)"))
        .execute(&pool)
        .await
        .unwrap();
    let bad_request = SyncRequest {
        target_table: unsafe_name.clone(),
        ..data_preview.request.clone()
    };
    let unsafe_preview = sync::preview(&db, &db, bad_request).await.unwrap();
    assert!(!unsafe_preview.data_supported);
    assert_eq!(unsafe_preview.counts.inserts, 0);
    assert_eq!(unsafe_preview.counts.updates, 0);

    sqlx::raw_sql(&format!(
        "DROP TABLE public.{src_name}, public.{dst_name}, public.{copy_name}, public.{unsafe_name}"
    ))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}

#[tokio::test]
async fn sqlite_table_copied_to_postgres_compares_clean_after_creation() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_PG_URL is not set");
        return;
    };
    let pg = sqlx::PgPool::connect(&url).await.expect("connect PostgreSQL");
    let sqlite = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE customers (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           email TEXT UNIQUE,
           vip INTEGER DEFAULT 0,
           created_at TEXT DEFAULT CURRENT_TIMESTAMP
         );
         INSERT INTO customers (name, email) VALUES ('a', 'a@x.test'), ('b', 'b@x.test');",
    )
    .execute(&sqlite)
    .await
    .unwrap();
    let target_name = format!("rdb_copy_{}", uuid::Uuid::new_v4().simple());
    let source = DbPool::Sqlite(sqlite);
    let target = DbPool::Postgres(pg.clone());
    let request = SyncRequest {
        source_id: "sqlite".into(),
        target_id: "pg".into(),
        source_schema: None,
        source_table: "customers".into(),
        target_schema: Some("public".into()),
        target_table: target_name.clone(),
        compare_deletes: false,
    };
    let preview = sync::preview(&source, &target, request).await.unwrap();
    assert!(preview.structure.supported, "{:?}", preview.structure.reason);
    sync::apply_structure(&target, &preview.structure).await.unwrap();

    // Re-comparing the freshly created table must not invent differences
    // (SQLite's nullable rowid PK, serial defaults, BIGSERIAL vs bigint).
    let refreshed = sync::preview(&source, &target, preview.request).await;
    let _ = sqlx::raw_sql(&format!("DROP TABLE IF EXISTS public.{target_name}"))
        .execute(&pg)
        .await;
    let refreshed = refreshed.unwrap();
    assert!(refreshed.structure.supported, "{:?}", refreshed.structure.reason);
    assert!(refreshed.structure.statements.is_empty());
    assert!(refreshed.data_supported, "{:?}", refreshed.data_reason);
    assert_eq!(refreshed.counts.inserts, 2);
}
