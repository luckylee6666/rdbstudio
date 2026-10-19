//! Live Redis coverage for bounded scan paging, Streams operations and list CAS.
//! Set RDBSTUDIO_TEST_REDIS_URL to exercise against a Redis server.
use rdbstudio_lib::db::pool::RedisHandle;
use rdbstudio_lib::db::redis_tools;
use redis::aio::ConnectionManager;

async fn handle() -> Option<RedisHandle> {
    let url = std::env::var("RDBSTUDIO_TEST_REDIS_URL").ok()?;
    let client = redis::Client::open(url).expect("parse Redis test URL");
    Some(RedisHandle::new(
        ConnectionManager::new(client).await.expect("connect Redis"),
        0,
    ))
}

async fn cleanup(handle: &RedisHandle, keys: &[String]) {
    let mut conn = handle.conn();
    let mut cmd = redis::cmd("DEL");
    for key in keys {
        cmd.arg(key);
    }
    let _: i64 = cmd.query_async(&mut conn).await.expect("cleanup keys");
}

#[tokio::test]
async fn hscan_and_sscan_walk_multiple_bounded_pages() {
    let Some(handle) = handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let suffix = uuid::Uuid::new_v4();
    let hash = format!("rdbstudio_test:{suffix}:hash");
    let set = format!("rdbstudio_test:{suffix}:set");
    cleanup(&handle, &[hash.clone(), set.clone()]).await;
    let mut conn = handle.conn();
    let mut hset = redis::cmd("HSET");
    hset.arg(&hash);
    let mut sadd = redis::cmd("SADD");
    sadd.arg(&set);
    for i in 0..650 {
        hset.arg(format!("field-{i}")).arg(format!("value-{i}"));
        sadd.arg(format!("member-{i}"));
    }
    let _: i64 = hset
        .query_async(&mut conn)
        .await
        .expect("create hash fields");
    let _: i64 = sadd
        .query_async(&mut conn)
        .await
        .expect("create set members");

    let mut hash_cursor = "0".to_string();
    let mut hash_items = Vec::new();
    for _ in 0..32 {
        let page = redis_tools::hscan(&handle, &hash, &hash_cursor)
            .await
            .expect("HSCAN page");
        hash_items.extend(page.items);
        if page.done {
            break;
        }
        assert_ne!(page.cursor, hash_cursor, "HSCAN cursor must advance");
        hash_cursor = page.cursor;
    }
    assert_eq!(hash_items.len(), 650);
    let hash_names: std::collections::HashSet<_> =
        hash_items.iter().map(|item| item.field.as_str()).collect();
    assert_eq!(
        hash_names.len(),
        650,
        "no hash field may be dropped or duplicated"
    );

    let mut set_cursor = "0".to_string();
    let mut set_items = Vec::new();
    for _ in 0..32 {
        let page = redis_tools::sscan(&handle, &set, &set_cursor)
            .await
            .expect("SSCAN page");
        set_items.extend(page.items);
        if page.done {
            break;
        }
        assert_ne!(page.cursor, set_cursor, "SSCAN cursor must advance");
        set_cursor = page.cursor;
    }
    assert_eq!(set_items.len(), 650);
    assert_eq!(
        set_items
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        650
    );
    cleanup(&handle, &[hash, set]).await;
}

#[tokio::test]
async fn stream_pages_and_consumer_group_lifecycle_work() {
    let Some(handle) = handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let key = format!("rdbstudio_test:{}:stream", uuid::Uuid::new_v4());
    cleanup(&handle, std::slice::from_ref(&key)).await;
    for i in 0..5 {
        redis_tools::xadd(&handle, &key, &[("n".into(), i.to_string())])
            .await
            .expect("XADD");
    }
    let first = redis_tools::xrange(&handle, &key, "-", 2, false)
        .await
        .expect("XRANGE first page");
    assert_eq!(first.items.len(), 2);
    assert!(!first.done);
    let second = redis_tools::xrange(&handle, &key, &first.cursor, 2, false)
        .await
        .expect("XRANGE second page");
    assert_eq!(second.items.len(), 2);
    assert_ne!(first.items[1].id, second.items[0].id);

    redis_tools::xgroup_create(&handle, &key, "workers")
        .await
        .expect("XGROUP CREATE");
    let groups = redis_tools::xinfo_groups(&handle, &key)
        .await
        .expect("XINFO GROUPS");
    assert!(groups.iter().any(|group| group.name == "workers"));
    assert!(redis_tools::xgroup_destroy(&handle, &key, "workers")
        .await
        .expect("XGROUP DESTROY"));
    assert_eq!(
        redis_tools::xdel(&handle, &key, &[first.items[0].id.clone()])
            .await
            .expect("XDEL"),
        1
    );
    cleanup(&handle, std::slice::from_ref(&key)).await;
}

#[tokio::test]
async fn list_compare_and_set_rejects_stale_values() {
    let Some(handle) = handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let key = format!("rdbstudio_test:{}:list", uuid::Uuid::new_v4());
    cleanup(&handle, std::slice::from_ref(&key)).await;
    let mut conn = handle.conn();
    let _: i64 = redis::cmd("RPUSH")
        .arg(&key)
        .arg("before")
        .query_async(&mut conn)
        .await
        .expect("RPUSH");
    redis_tools::list_set_cas(&handle, &key, 0, "before", "after")
        .await
        .expect("CAS write");
    let current: String = redis::cmd("LINDEX")
        .arg(&key)
        .arg(0)
        .query_async(&mut conn)
        .await
        .expect("LINDEX");
    assert_eq!(current, "after");
    assert!(
        redis_tools::list_set_cas(&handle, &key, 0, "stale", "wrong")
            .await
            .is_err()
    );
    let current: String = redis::cmd("LINDEX")
        .arg(&key)
        .arg(0)
        .query_async(&mut conn)
        .await
        .expect("LINDEX after stale CAS");
    assert_eq!(
        current, "after",
        "a stale edit must not overwrite a newer value"
    );
    cleanup(&handle, std::slice::from_ref(&key)).await;
}

#[tokio::test]
async fn list_delete_cas_removes_the_selected_duplicate_and_preserves_ttl() {
    let Some(handle) = handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let key = format!("rdbstudio_test:{}:list-delete", uuid::Uuid::new_v4());
    cleanup(&handle, std::slice::from_ref(&key)).await;
    let mut conn = handle.conn();
    let _: i64 = redis::cmd("RPUSH")
        .arg(&key)
        .arg("duplicate")
        .arg("middle")
        .arg("duplicate")
        .query_async(&mut conn)
        .await
        .expect("RPUSH");
    let _: i64 = redis::cmd("EXPIRE")
        .arg(&key)
        .arg(60)
        .query_async(&mut conn)
        .await
        .expect("EXPIRE");

    assert!(redis_tools::list_delete_cas(&handle, &key, 2, "stale")
        .await
        .is_err());
    redis_tools::list_delete_cas(&handle, &key, 2, "duplicate")
        .await
        .expect("delete selected duplicate");
    let after_tail: Vec<String> = redis::cmd("LRANGE")
        .arg(&key)
        .arg(0)
        .arg(-1)
        .query_async(&mut conn)
        .await
        .expect("LRANGE after tail-side delete");
    assert_eq!(
        after_tail,
        vec!["duplicate".to_string(), "middle".to_string()]
    );

    redis_tools::list_delete_cas(&handle, &key, 0, "duplicate")
        .await
        .expect("delete head-side duplicate");
    let after_head: Vec<String> = redis::cmd("LRANGE")
        .arg(&key)
        .arg(0)
        .arg(-1)
        .query_async(&mut conn)
        .await
        .expect("LRANGE after head-side delete");
    assert_eq!(after_head, vec!["middle".to_string()]);
    let ttl: i64 = redis::cmd("TTL")
        .arg(&key)
        .query_async(&mut conn)
        .await
        .expect("TTL after list mutation");
    assert!(ttl > 0, "list deletion must preserve the existing TTL");
    cleanup(&handle, std::slice::from_ref(&key)).await;
}
