//! Redis key-management paths against a live server.
//!
//! Covers create (each kind, with TTL), duplicate-create rejection, rename
//! (success + destination-exists rejection), TTL set/persist, and member
//! deletion for hash/set/zset. Every key lives under a unique
//! `rdbstudio_test:<uuid>` prefix and is deleted on the way out.
//!
//! Needs a live Redis; set `RDBSTUDIO_TEST_REDIS_URL` to run it:
//!
//! ```text
//! RDBSTUDIO_TEST_REDIS_URL=redis://127.0.0.1:6379 \
//!     cargo test --test redis_paths
//! ```

use redis::aio::ConnectionManager;
use rdbstudio_lib::db::pool::RedisHandle;
use rdbstudio_lib::db::redis_ops;

async fn redis_handle() -> Option<RedisHandle> {
    let url = std::env::var("RDBSTUDIO_TEST_REDIS_URL").ok()?;
    let client = redis::Client::open(url).expect("parse RDBSTUDIO_TEST_REDIS_URL");
    let mgr = ConnectionManager::new(client)
        .await
        .expect("connect to RDBSTUDIO_TEST_REDIS_URL");
    Some(RedisHandle::new(mgr, 0))
}

async fn cleanup(handle: &RedisHandle, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let mut conn = handle.conn();
    let mut cmd = redis::cmd("DEL");
    for k in keys {
        cmd.arg(k);
    }
    let _: i64 = cmd.query_async(&mut conn).await.expect("cleanup DEL");
}

async fn int(handle: &RedisHandle, command: &str, args: &[&str]) -> i64 {
    let mut conn = handle.conn();
    let mut cmd = redis::cmd(command);
    for a in args {
        cmd.arg(*a);
    }
    cmd.query_async(&mut conn).await.expect("redis int reply")
}

async fn str_reply(handle: &RedisHandle, command: &str, args: &[&str]) -> Option<String> {
    let mut conn = handle.conn();
    let mut cmd = redis::cmd(command);
    for a in args {
        cmd.arg(*a);
    }
    cmd.query_async(&mut conn)
        .await
        .expect("redis string reply")
}

fn prefix() -> String {
    format!("rdbstudio_test:{}:", uuid::Uuid::new_v4())
}

#[tokio::test]
async fn create_each_kind_with_ttl() {
    let Some(handle) = redis_handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let p = prefix();
    let keys: Vec<String> = ["s", "h", "l", "set", "z"]
        .iter()
        .map(|s| format!("{p}{s}"))
        .collect();
    cleanup(&handle, &keys).await;

    redis_ops::create_key(&handle, &keys[0], "string", "hello world", None, None, Some(120))
        .await
        .expect("create string");
    assert_eq!(
        str_reply(&handle, "GET", &[&keys[0]]).await.as_deref(),
        Some("hello world")
    );
    assert!(int(&handle, "TTL", &[&keys[0]]).await > 0, "string TTL missing");

    redis_ops::create_key(&handle, &keys[1], "hash", "Alice", Some("name"), None, None)
        .await
        .expect("create hash");
    assert_eq!(
        str_reply(&handle, "HGET", &[&keys[1], "name"]).await.as_deref(),
        Some("Alice")
    );

    redis_ops::create_key(&handle, &keys[2], "list", "first", None, None, None)
        .await
        .expect("create list");
    assert_eq!(int(&handle, "LLEN", &[&keys[2]]).await, 1);

    redis_ops::create_key(&handle, &keys[3], "set", "member", None, None, None)
        .await
        .expect("create set");
    assert_eq!(int(&handle, "SISMEMBER", &[&keys[3], "member"]).await, 1);

    redis_ops::create_key(&handle, &keys[4], "zset", "member", None, Some(42.5), None)
        .await
        .expect("create zset");
    assert_eq!(
        str_reply(&handle, "ZSCORE", &[&keys[4], "member"]).await.as_deref(),
        Some("42.5")
    );

    cleanup(&handle, &keys).await;
}

#[tokio::test]
async fn duplicate_create_is_rejected() {
    let Some(handle) = redis_handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let p = prefix();
    let skey = format!("{p}string");
    let hkey = format!("{p}hash");
    cleanup(&handle, &[skey.clone(), hkey.clone()]).await;

    redis_ops::create_key(&handle, &skey, "string", "one", None, None, None)
        .await
        .expect("create string");
    let err = redis_ops::create_key(&handle, &skey, "string", "two", None, None, None)
        .await
        .expect_err("duplicate string must fail");
    assert!(err.to_string().contains("already exists"), "{err}");

    redis_ops::create_key(&handle, &hkey, "hash", "v", Some("f"), None, None)
        .await
        .expect("create hash");
    let err = redis_ops::create_key(&handle, &hkey, "hash", "v2", Some("f2"), None, None)
        .await
        .expect_err("duplicate hash must fail");
    assert!(err.to_string().contains("already exists"), "{err}");

    cleanup(&handle, &[skey, hkey]).await;
}

#[tokio::test]
async fn rename_to_existing_is_rejected_and_rename_moves_value() {
    let Some(handle) = redis_handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let p = prefix();
    let a = format!("{p}a");
    let b = format!("{p}b");
    let c = format!("{p}c");
    cleanup(&handle, &[a.clone(), b.clone(), c.clone()]).await;

    redis_ops::create_key(&handle, &a, "string", "alpha", None, None, None)
        .await
        .expect("create a");
    redis_ops::create_key(&handle, &b, "string", "beta", None, None, None)
        .await
        .expect("create b");

    let err = redis_ops::rename_key(&handle, &a, &b)
        .await
        .expect_err("rename onto an existing key must fail");
    assert!(err.to_string().contains("already exists"), "{err}");
    assert_eq!(int(&handle, "EXISTS", &[&a]).await, 1, "source vanished");
    assert_eq!(int(&handle, "EXISTS", &[&b]).await, 1);
    assert_eq!(
        str_reply(&handle, "GET", &[&b]).await.as_deref(),
        Some("beta"),
        "destination was overwritten"
    );

    redis_ops::rename_key(&handle, &a, &c).await.expect("rename a -> c");
    assert_eq!(int(&handle, "EXISTS", &[&a]).await, 0, "old key still exists");
    assert_eq!(int(&handle, "EXISTS", &[&c]).await, 1);
    assert_eq!(
        str_reply(&handle, "GET", &[&c]).await.as_deref(),
        Some("alpha")
    );

    cleanup(&handle, &[a, b, c]).await;
}

#[tokio::test]
async fn set_and_persist_ttl() {
    let Some(handle) = redis_handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let p = prefix();
    let key = format!("{p}ttl");
    let missing = format!("{p}missing");
    cleanup(&handle, &[key.clone(), missing.clone()]).await;

    redis_ops::create_key(&handle, &key, "string", "v", None, None, None)
        .await
        .expect("create key");
    assert_eq!(int(&handle, "PTTL", &[&key]).await, -1, "expected no expiry");

    assert!(redis_ops::set_ttl(&handle, &key, Some(120)).await.expect("expire"));
    let pttl = int(&handle, "PTTL", &[&key]).await;
    assert!(pttl > 0 && pttl <= 120_000, "unexpected PTTL {pttl}");

    assert!(redis_ops::set_ttl(&handle, &key, None).await.expect("persist"));
    assert_eq!(int(&handle, "PTTL", &[&key]).await, -1, "expiry not cleared");

    assert!(
        !redis_ops::set_ttl(&handle, &missing, Some(60)).await.expect("missing key"),
        "EXPIRE on a missing key must report it did not exist"
    );

    let err = redis_ops::set_ttl(&handle, &key, Some(0))
        .await
        .expect_err("zero TTL must be rejected");
    assert!(err.to_string().contains("greater than 0"), "{err}");

    cleanup(&handle, &[key, missing]).await;
}

#[tokio::test]
async fn delete_members_for_hash_set_zset() {
    let Some(handle) = redis_handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let p = prefix();
    let hkey = format!("{p}hash");
    let skey = format!("{p}set");
    let zkey = format!("{p}zset");
    cleanup(&handle, &[hkey.clone(), skey.clone(), zkey.clone()]).await;

    redis_ops::create_key(&handle, &hkey, "hash", "v", Some("f"), None, None)
        .await
        .expect("create hash");
    redis_ops::create_key(&handle, &skey, "set", "m", None, None, None)
        .await
        .expect("create set");
    redis_ops::create_key(&handle, &zkey, "zset", "m", None, Some(1.0), None)
        .await
        .expect("create zset");

    assert_eq!(
        redis_ops::delete_member(&handle, &hkey, "hash", "f").await.expect("HDEL"),
        1
    );
    assert_eq!(
        redis_ops::delete_member(&handle, &skey, "set", "m").await.expect("SREM"),
        1
    );
    assert_eq!(
        redis_ops::delete_member(&handle, &zkey, "zset", "m").await.expect("ZREM"),
        1
    );

    assert_eq!(
        redis_ops::delete_member(&handle, &hkey, "hash", "f").await.expect("HDEL again"),
        0,
        "deleting an absent member must report zero"
    );

    let err = redis_ops::delete_member(&handle, &hkey, "list", "x")
        .await
        .expect_err("list member deletion must be refused");
    assert!(err.to_string().contains("not supported"), "{err}");

    cleanup(&handle, &[hkey, skey, zkey]).await;
}

#[tokio::test]
async fn create_rejects_bad_arguments() {
    let Some(handle) = redis_handle().await else {
        eprintln!("skipped: RDBSTUDIO_TEST_REDIS_URL is not set");
        return;
    };
    let p = prefix();
    let key = format!("{p}bad");
    cleanup(&handle, std::slice::from_ref(&key)).await;

    let err = redis_ops::create_key(&handle, &key, "stream", "v", None, None, None)
        .await
        .expect_err("unsupported kind must fail");
    assert!(err.to_string().contains("unsupported"), "{err}");

    let err = redis_ops::create_key(&handle, &key, "hash", "v", None, None, None)
        .await
        .expect_err("hash without a field must fail");
    assert!(err.to_string().contains("field"), "{err}");

    let err = redis_ops::create_key(&handle, &key, "zset", "v", None, None, None)
        .await
        .expect_err("zset without a score must fail");
    assert!(err.to_string().contains("score"), "{err}");

    let err = redis_ops::create_key(&handle, &key, "string", "v", None, None, Some(-5))
        .await
        .expect_err("negative TTL must fail");
    assert!(err.to_string().contains("TTL"), "{err}");

    assert_eq!(int(&handle, "EXISTS", &[&key]).await, 0, "bad create left a key");
}
