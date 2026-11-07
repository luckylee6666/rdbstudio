mod common;
use rdbstudio_lib::db::{
    exec::ScriptOutcome,
    parameters::{ParameterKind, QueryParameter},
    pool::DbPool,
    sessions::{EditorSessions, ParameterExecution},
};
use serde_json::json;

fn p(name: &str, kind: ParameterKind, value: Option<&str>) -> QueryParameter {
    QueryParameter {
        name: name.into(),
        kind,
        value: value.map(str::to_owned),
    }
}
async fn execute(
    sessions: &EditorSessions,
    pool: &DbPool,
    sql: &[&str],
    parameters: &[QueryParameter],
    atomic: bool,
) -> ScriptOutcome {
    sessions
        .execute_parameterized(
            "c",
            "tab",
            sessions.lease("c").unwrap(),
            pool,
            &sql.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            ParameterExecution { parameters, atomic },
        )
        .await
        .unwrap()
}
fn rows(result: ScriptOutcome) -> Vec<Vec<serde_json::Value>> {
    match result {
        ScriptOutcome::Ok { result, .. } => result.rows,
        ScriptOutcome::Failed { error, .. } => panic!("{error}"),
    }
}

#[tokio::test]
async fn sqlite_native_binding_keeps_types_null_empty_and_injection_text() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    let attack = "'; DROP TABLE saved; -- 水😃";
    let params = [
        p("text", ParameterKind::Text, Some(attack)),
        p("empty", ParameterKind::Text, Some("")),
        p("null", ParameterKind::Integer, None),
        p("min", ParameterKind::Integer, Some("-9223372036854775808")),
        p("max", ParameterKind::Integer, Some("9223372036854775807")),
        p("bool", ParameterKind::Boolean, Some("true")),
        p("date", ParameterKind::Date, Some("2024-02-29")),
        p(
            "datetime",
            ParameterKind::Datetime,
            Some("2026-11-06T12:34:56.123"),
        ),
        p("json", ParameterKind::Json, Some("{\"emoji\":\"😃\"}")),
        p("bytes", ParameterKind::Binary, Some("0x00aaff")),
        p("decimal", ParameterKind::Decimal, Some("12.25")),
    ];
    let values = rows(execute(&sessions, &pool, &["SELECT :text, :empty, :null, :min, :max, :bool, :date, :datetime, :json, hex(:bytes), :decimal, :text"], &params, false).await);
    assert_eq!(values[0][0], attack);
    assert_eq!(values[0][1], "");
    assert_eq!(values[0][2], serde_json::Value::Null);
    assert_eq!(values[0][3], json!(i64::MIN.to_string()));
    assert_eq!(values[0][4], json!(i64::MAX.to_string()));
    assert_eq!(values[0][5], 1);
    assert_eq!(values[0][6], "2024-02-29");
    assert!(values[0][7]
        .as_str()
        .unwrap()
        .starts_with("2026-11-06 12:34:56.123"));
    assert_eq!(values[0][8], "{\"emoji\":\"😃\"}");
    assert_eq!(values[0][9], "00AAFF");
    assert_eq!(values[0][10], json!(12.25));
    assert_eq!(values[0][11], attack);
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn parameters_share_editor_transactions_and_atomic_failures_rollback() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    rows(
        execute(
            &sessions,
            &pool,
            &["CREATE TEMP TABLE saved(id INTEGER PRIMARY KEY, value TEXT)"],
            &[],
            false,
        )
        .await,
    );
    let params = [
        p("id", ParameterKind::Integer, Some("42")),
        p("value", ParameterKind::Text, Some("retained")),
    ];
    rows(
        execute(
            &sessions,
            &pool,
            &["BEGIN", "INSERT INTO saved VALUES (:id, :value)"],
            &params,
            false,
        )
        .await,
    );
    assert!(sessions.status("tab").await.in_transaction);
    assert_eq!(
        rows(
            execute(
                &sessions,
                &pool,
                &["SELECT value FROM saved WHERE id = :id"],
                &params,
                false
            )
            .await
        )[0][0],
        "retained"
    );
    rows(execute(&sessions, &pool, &["ROLLBACK"], &[], false).await);
    assert_eq!(
        rows(
            execute(
                &sessions,
                &pool,
                &["SELECT count(*) FROM saved"],
                &[],
                false
            )
            .await
        )[0][0],
        0
    );
    let failed = execute(
        &sessions,
        &pool,
        &[
            "INSERT INTO saved VALUES (:id, :value)",
            "INSERT INTO saved VALUES (:id, :value)",
        ],
        &params,
        true,
    )
    .await;
    assert!(matches!(
        failed,
        ScriptOutcome::Failed {
            failed_index: 1,
            ..
        }
    ));
    assert_eq!(
        rows(
            execute(
                &sessions,
                &pool,
                &["SELECT count(*) FROM saved"],
                &[],
                false
            )
            .await
        )[0][0],
        0
    );
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn malformed_unused_value_is_rejected_before_any_write() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    rows(
        execute(
            &sessions,
            &pool,
            &["CREATE TABLE saved(id INTEGER)"],
            &[],
            false,
        )
        .await,
    );
    let result = sessions
        .execute_parameterized(
            "c",
            "tab",
            sessions.lease("c").unwrap(),
            &pool,
            &[
                "INSERT INTO saved VALUES (1)".into(),
                "SELECT :invalid".into(),
            ],
            ParameterExecution {
                parameters: &[p("invalid", ParameterKind::Date, Some("2026-02-30"))],
                atomic: false,
            },
        )
        .await;
    assert!(result.is_err());
    assert_eq!(
        rows(
            execute(
                &sessions,
                &pool,
                &["SELECT count(*) FROM saved"],
                &[],
                false
            )
            .await
        )[0][0],
        0
    );
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn stale_generation_cannot_create_a_parameter_session() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    let generation = sessions.lease("c").unwrap();
    sessions.close_connection("c").await;
    sessions.mark_connected("c");
    let result = sessions
        .execute_parameterized(
            "c",
            "tab",
            generation,
            &pool,
            &["SELECT :id".into()],
            ParameterExecution {
                parameters: &[p("id", ParameterKind::Integer, Some("1"))],
                atomic: false,
            },
        )
        .await;
    assert!(result.is_err());
    assert!(!sessions.status("tab").await.connected);
}

#[tokio::test]
async fn missing_parameter_is_rejected_before_a_non_atomic_write() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    rows(
        execute(
            &sessions,
            &pool,
            &["CREATE TABLE saved(id INTEGER)"],
            &[],
            false,
        )
        .await,
    );
    let result = sessions
        .execute_parameterized(
            "c",
            "tab",
            sessions.lease("c").unwrap(),
            &pool,
            &[
                "INSERT INTO saved VALUES (1)".into(),
                "SELECT :missing".into(),
            ],
            ParameterExecution {
                parameters: &[],
                atomic: false,
            },
        )
        .await;
    assert!(result.is_err());
    assert_eq!(
        rows(
            execute(
                &sessions,
                &pool,
                &["SELECT count(*) FROM saved"],
                &[],
                false
            )
            .await
        )[0][0],
        0
    );
    sessions.close_connection("c").await;
}

async fn live_types(pool: DbPool, postgres: bool) {
    let sessions = EditorSessions::default();
    let params = [
        p(
            "value",
            ParameterKind::Text,
            Some("'; DROP TABLE saved; -- 水😃\\"),
        ),
        p("min", ParameterKind::Integer, Some("-9223372036854775808")),
        p("max", ParameterKind::Integer, Some("9223372036854775807")),
        p(
            "decimal",
            ParameterKind::Decimal,
            Some("12345678901234567890.123456789"),
        ),
        p("bool", ParameterKind::Boolean, Some("true")),
        p("date", ParameterKind::Date, Some("2024-02-29")),
        p(
            "dt",
            ParameterKind::Datetime,
            Some("2026-11-06 12:34:56.123"),
        ),
        p("json", ParameterKind::Json, Some("{\"a\":1}")),
        p("bytes", ParameterKind::Binary, Some("00aaff")),
        p("null", ParameterKind::Text, None),
        p("empty", ParameterKind::Text, Some("")),
    ];
    let sql = if postgres {
        "SELECT :value, :min, :max, :decimal, :bool, :date, :dt, :json, encode(:bytes, 'hex'), :null, :empty, :value"
    } else {
        "SELECT :value, :min, :max, :decimal, :bool, :date, :dt, :json, LOWER(HEX(:bytes)), :null, :empty, :value"
    };
    let result = rows(execute(&sessions, &pool, &[sql], &params, false).await);
    assert_eq!(result[0][0], params[0].value.as_ref().unwrap().as_str());
    assert_eq!(result[0][1], i64::MIN.to_string());
    assert_eq!(result[0][2], i64::MAX.to_string());
    assert_eq!(result[0][3], "12345678901234567890.123456789");
    assert!(result[0][4] == json!(true) || result[0][4] == json!(1));
    assert_eq!(result[0][5], "2024-02-29");
    assert!(result[0][6].as_str().unwrap().contains("12:34:56.123"));
    let json_value = if let Some(value) = result[0][7].as_str() {
        serde_json::from_str(value).unwrap()
    } else {
        result[0][7].clone()
    };
    assert_eq!(json_value, json!({"a":1}));
    assert_eq!(result[0][8], "00aaff");
    assert_eq!(result[0][9], serde_json::Value::Null);
    assert_eq!(result[0][10], "");
    assert_eq!(result[0][11], result[0][0]);
    let names = [
        p("plain", ParameterKind::Integer, Some("42")),
        p("escaped", ParameterKind::Integer, Some("99")),
    ];
    let ambiguous = "SELECT 'slash\\', :plain -- ' AS literal, :escaped AS result";
    let modes = if postgres {
        [
            "SELECT set_config('standard_conforming_strings', 'off', false)",
            "SET standard_conforming_strings=on",
        ]
    } else {
        [
            "SET SESSION sql_mode=''",
            "SET SESSION sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'",
        ]
    };
    let escaped = rows(execute(&sessions, &pool, &[modes[0], ambiguous], &names, false).await);
    assert_eq!(escaped[0][1], 99);
    let plain = rows(execute(&sessions, &pool, &[modes[1], ambiguous], &names, false).await);
    assert_eq!(plain[0][1], 42);
    // Bindings still share the native session, including transaction control
    // through MySQL's unprepared text protocol.
    rows(
        execute(
            &sessions,
            &pool,
            &[
                "CREATE TEMPORARY TABLE param_saved(id BIGINT)",
                "BEGIN",
                "INSERT INTO param_saved VALUES (:max)",
            ],
            &params,
            false,
        )
        .await,
    );
    assert!(sessions.status("tab").await.in_transaction);
    rows(execute(&sessions, &pool, &["ROLLBACK"], &[], false).await);
    assert_eq!(
        rows(
            execute(
                &sessions,
                &pool,
                &["SELECT count(*) FROM param_saved"],
                &[],
                false
            )
            .await
        )[0][0],
        0
    );
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn postgres_native_parameters_and_mid_script_mode_changes() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_PG_URL") else {
        return;
    };
    live_types(
        DbPool::Postgres(sqlx::PgPool::connect(&url).await.unwrap()),
        true,
    )
    .await;
}
#[tokio::test]
async fn mysql_native_parameters_and_mid_script_mode_changes() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        return;
    };
    live_types(
        DbPool::Mysql(sqlx::MySqlPool::connect(&url).await.unwrap()),
        false,
    )
    .await;
}

#[tokio::test]
async fn cancelled_parameter_query_discards_dirty_session_and_reset_rolls_back() {
    let pool = common::mem_pool().await;
    let sessions = std::sync::Arc::new(EditorSessions::default());
    rows(
        execute(
            &sessions,
            &pool,
            &[
                "CREATE TABLE saved(id INTEGER)",
                "BEGIN",
                "INSERT INTO saved VALUES(1)",
            ],
            &[],
            false,
        )
        .await,
    );
    let worker_sessions = sessions.clone();
    let worker_pool = pool.clone();
    let task = tokio::spawn(async move {
        execute(&worker_sessions, &worker_pool, &["WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<:limit) SELECT sum(x) FROM n"], &[p("limit", ParameterKind::Integer, Some("1000000000"))], false).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(sessions.status("tab").await.needs_reset);
    sessions.close("tab").await;
    let recovered = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        execute(
            &sessions,
            &pool,
            &["SELECT count(*) FROM saved"],
            &[],
            false,
        ),
    )
    .await
    .unwrap();
    assert_eq!(rows(recovered)[0][0], 0);
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn sqlite_expression_columns_use_runtime_types_and_preserve_raw_binary() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    let params = [
        p("text", ParameterKind::Text, Some("hello")),
        p("int", ParameterKind::Integer, Some("42")),
        p("blob", ParameterKind::Binary, Some("00aaff")),
    ];
    let result = execute(
        &sessions,
        &pool,
        &["SELECT :text AS text, :int AS integer, :blob AS binary"],
        &params,
        false,
    )
    .await;
    let ScriptOutcome::Ok { result, .. } = result else {
        panic!("query failed")
    };
    assert_eq!(
        result
            .columns
            .iter()
            .map(|column| column.data_type.as_str())
            .collect::<Vec<_>>(),
        ["TEXT", "INTEGER", "BLOB"]
    );
    assert_eq!(result.rows[0][2], "AKr/");
    let mixed = rows(
        execute(
            &sessions,
            &pool,
            &["SELECT :int AS value UNION ALL SELECT :text UNION ALL SELECT :blob"],
            &params,
            false,
        )
        .await,
    );
    assert_eq!(
        mixed,
        vec![vec![json!(42)], vec![json!("hello")], vec![json!("AKr/")]]
    );
    sessions.close_connection("c").await;
}

#[tokio::test]
async fn repeated_large_bindings_are_bounded_before_any_write() {
    let pool = common::mem_pool().await;
    let sessions = EditorSessions::default();
    rows(
        execute(
            &sessions,
            &pool,
            &["CREATE TABLE saved(id INTEGER)"],
            &[],
            false,
        )
        .await,
    );
    let repeated = format!("SELECT {}", [":large"; 9].join(", "));
    let result = sessions
        .execute_parameterized(
            "c",
            "tab",
            sessions.lease("c").unwrap(),
            &pool,
            &["INSERT INTO saved VALUES(1)".into(), repeated],
            ParameterExecution {
                parameters: &[p(
                    "large",
                    ParameterKind::Text,
                    Some(&"x".repeat(1024 * 1024)),
                )],
                atomic: false,
            },
        )
        .await;
    assert!(result.is_err());
    assert_eq!(
        rows(
            execute(
                &sessions,
                &pool,
                &["SELECT count(*) FROM saved"],
                &[],
                false
            )
            .await
        )[0][0],
        0
    );
    sessions.close_connection("c").await;
}
