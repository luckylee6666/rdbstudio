use rdbstudio_lib::db::pool::DbPool;
use rdbstudio_lib::db::sync::{self, ConflictPolicy, SyncRequest};
use sqlx::Row;

#[tokio::test]
async fn mysql_sync_preserves_unsigned_bigint_decimal_null_binary_and_creates_reviewed_table() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is not set");
        return;
    };
    let pool = sqlx::MySqlPool::connect(&url).await.expect("connect MySQL");
    let src_name = format!("rdb_sync_src_{}", uuid::Uuid::new_v4().simple());
    let dst_name = format!("rdb_sync_dst_{}", uuid::Uuid::new_v4().simple());
    let copy_name = format!("rdb_sync_copy_{}", uuid::Uuid::new_v4().simple());
    let create = |name: &str| {
        format!(
            "CREATE TABLE `{name}` (id BIGINT UNSIGNED PRIMARY KEY, amount DECIMAL(20,8) NOT NULL, note TEXT NULL, payload LONGBLOB NULL) ENGINE=InnoDB"
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
    sqlx::raw_sql(&format!(
        "INSERT INTO `{src_name}` VALUES (18446744073709551615, 123456789012.12345678, NULL, X'00FF1080')"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(&format!(
        "INSERT INTO `{dst_name}` VALUES (18446744073709551615, 0, 'stale', X'01')"
    ))
    .execute(&pool)
    .await
    .unwrap();

    let db = DbPool::Mysql(pool.clone());
    let request = SyncRequest {
        source_id: "mysql-source".into(),
        target_id: "mysql-target".into(),
        source_schema: None,
        source_table: src_name.clone(),
        target_schema: None,
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
        "SELECT CAST(id AS CHAR) AS id, CAST(amount AS CHAR) AS amount, note, payload FROM `{dst_name}`"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.try_get::<String, _>("id").unwrap(),
        "18446744073709551615"
    );
    assert_eq!(
        row.try_get::<String, _>("amount").unwrap(),
        "123456789012.12345678"
    );
    assert_eq!(row.try_get::<Option<String>, _>("note").unwrap(), None);
    assert_eq!(
        row.try_get::<Vec<u8>, _>("payload").unwrap(),
        vec![0, 255, 16, 128]
    );

    // DDL preview preserves the unsigned range and precision before it is run.
    let mut copy_request = request;
    copy_request.target_table = copy_name.clone();
    let structure = sync::preview(&db, &db, copy_request.clone()).await.unwrap();
    assert!(
        structure.structure.supported,
        "{:?}",
        structure.structure.reason
    );
    assert!(structure.structure.statements[0].contains("BIGINT UNSIGNED"));
    assert!(structure.structure.statements[0].contains("DECIMAL(20,8)"));
    sync::apply_structure(&db, &structure.structure)
        .await
        .unwrap();
    let data = sync::preview(&db, &db, copy_request).await.unwrap();
    assert!(data.data_supported, "{:?}", data.data_reason);
    assert_eq!(data.counts.inserts, 1);
    sync::apply_data(&db, &data, ConflictPolicy::InsertOnly)
        .await
        .unwrap();
    let copied = sqlx::query(&format!(
        "SELECT CAST(id AS CHAR) AS id, CAST(amount AS CHAR) AS amount, note, payload FROM `{copy_name}`"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        copied.try_get::<String, _>("id").unwrap(),
        "18446744073709551615"
    );
    assert_eq!(
        copied.try_get::<String, _>("amount").unwrap(),
        "123456789012.12345678"
    );
    assert_eq!(copied.try_get::<Option<String>, _>("note").unwrap(), None);
    assert_eq!(
        copied.try_get::<Vec<u8>, _>("payload").unwrap(),
        vec![0, 255, 16, 128]
    );

    sqlx::raw_sql(&format!(
        "DROP TABLE `{src_name}`, `{dst_name}`, `{copy_name}`"
    ))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}

#[tokio::test]
async fn mysql_auto_increment_transfer_keeps_the_next_generated_id_above_copied_rows() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        return;
    };
    let pool = sqlx::MySqlPool::connect(&url).await.unwrap();
    let source = format!("rdb_auto_src_{}", uuid::Uuid::new_v4().simple());
    let target = format!("rdb_auto_dst_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(&format!("CREATE TABLE `{source}`(id BIGINT AUTO_INCREMENT PRIMARY KEY,value TEXT); INSERT INTO `{source}`(id,value) VALUES(30,'copied')")).execute(&pool).await.unwrap();
    let database: String = sqlx::query_scalar("SELECT CAST(DATABASE() AS CHAR)")
        .fetch_one(&pool)
        .await
        .unwrap();
    let db = DbPool::Mysql(pool.clone());
    let request = SyncRequest {
        source_id: "src".into(),
        target_id: "dst".into(),
        source_schema: Some(database.clone()),
        target_schema: Some(database),
        source_table: source.clone(),
        target_table: target.clone(),
        compare_deletes: false,
    };
    let plan = sync::preview(&db, &db, request.clone()).await.unwrap();
    assert!(plan.structure.supported, "{:?}", plan.structure.reason);
    sync::apply_structure(&db, &plan.structure).await.unwrap();
    let plan = sync::preview(&db, &db, request).await.unwrap();
    assert!(plan.data_supported, "{:?}", plan.data_reason);
    sync::apply_data(&db, &plan, ConflictPolicy::InsertOnly)
        .await
        .unwrap();
    let result = sqlx::query(&format!("INSERT INTO `{target}`(value) VALUES('next')"))
        .execute(&pool)
        .await
        .unwrap();
    assert!(result.last_insert_id() > 30);
    sqlx::raw_sql(&format!("DROP TABLE `{source}`,`{target}`"))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
