use rdbstudio_lib::db::event_tools::{self, EventIntervalUnit, EventOptions, EventSchedule};
use rdbstudio_lib::db::pool::DbPool;
use rdbstudio_lib::model::DriverKind;

#[tokio::test]
async fn mysql_event_lifecycle_preserves_metadata_and_untouched_complex_body() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        eprintln!("skipped: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is not set");
        return;
    };
    let pool = sqlx::MySqlPool::connect(&url)
        .await
        .expect("connect isolated MySQL scratch database");
    let schema: String = sqlx::query_scalar("SELECT DATABASE()")
        .fetch_one(&pool)
        .await
        .expect("scratch URL selects a database");
    let name = format!("rdb_event_{}", uuid::Uuid::new_v4().simple());
    let db = DbPool::Mysql(pool.clone());
    let options = EventOptions {
        schema: schema.clone(),
        name: name.clone(),
        schedule: EventSchedule::Every {
            interval_value: "1".into(),
            interval_unit: EventIntervalUnit::Day,
            starts: Some("2030-01-02 03:04:05".into()),
            ends: None,
        },
        body: "SET @rdb_event_test = 1".into(),
        comment: "event tools integration create".into(),
        preserve: true,
    };

    event_tools::save_event(&db, options.clone(), true)
        .await
        .expect("create disabled future event");
    let created = event_tools::get_event_options(&db, &schema, &name)
        .await
        .expect("read created event");
    assert!(!created.enabled);
    assert_eq!(created.options.schedule, options.schedule);
    assert_eq!(created.options.body, options.body);
    assert_eq!(created.options.comment, options.comment);
    assert!(created.options.preserve);
    assert!(!created.definer.is_empty());
    assert!(!created.time_zone.is_empty());
    assert!(!created.scheduler.is_empty());

    // Simulate a legacy event with a compound body. The editor leaves the body
    // untouched while changing its schedule/comment and must omit DO in ALTER.
    let qualified = format!(
        "{}.{}",
        rdbstudio_lib::db::data::quote_ident(DriverKind::Mysql, &schema),
        rdbstudio_lib::db::data::quote_ident(DriverKind::Mysql, &name),
    );
    sqlx::raw_sql(&format!(
        "ALTER EVENT {qualified} DO BEGIN SET @rdb_event_test = 1; SET @rdb_event_test = 2; END"
    ))
    .execute(&pool)
    .await
    .expect("install dormant legacy compound event body");
    let legacy = event_tools::get_event_options(&db, &schema, &name)
        .await
        .expect("read legacy compound body");
    assert!(legacy.options.body.contains("BEGIN"));
    let mut changed = legacy.options.clone();
    changed.schedule = EventSchedule::Every {
        interval_value: "2".into(),
        interval_unit: EventIntervalUnit::Hour,
        starts: Some("2030-02-03 04:05:06".into()),
        ends: None,
    };
    changed.comment = "event tools integration altered".into();
    event_tools::save_event(&db, changed.clone(), false)
        .await
        .expect("alter without rewriting unchanged complex body");
    let altered = event_tools::get_event_options(&db, &schema, &name)
        .await
        .expect("read altered event");
    assert!(!altered.enabled);
    assert_eq!(altered.options.schedule, changed.schedule);
    assert_eq!(altered.options.comment, changed.comment);
    assert_eq!(altered.options.body, legacy.options.body);
    assert_eq!(altered.definer, created.definer);
    assert_eq!(altered.time_zone, created.time_zone);
    assert_eq!(altered.options.preserve, created.options.preserve);

    event_tools::set_event_enabled(&db, &schema, &name, true)
        .await
        .expect("enable event with distant future start");
    let enabled = event_tools::get_event_options(&db, &schema, &name)
        .await
        .expect("read enabled event");
    assert!(enabled.enabled);
    assert_eq!(enabled.definer, created.definer);
    assert_eq!(enabled.time_zone, created.time_zone);
    event_tools::set_event_enabled(&db, &schema, &name, false)
        .await
        .expect("disable event before its future start");
    assert!(
        !event_tools::get_event_options(&db, &schema, &name)
            .await
            .expect("read disabled event")
            .enabled
    );

    event_tools::drop_event(&db, &schema, &name)
        .await
        .expect("drop test event");
    let missing = event_tools::get_event_options(&db, &schema, &name)
        .await
        .expect_err("deleted event should not be readable");
    assert!(missing.to_string().contains("no longer exists"));
    pool.close().await;
}
