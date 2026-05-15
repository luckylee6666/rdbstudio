mod common;

use rdbstudio_lib::db::alter::{self, ColumnEdit, DesignerChange};
use rdbstudio_lib::db::meta;

fn edit(
    original: Option<&str>,
    name: &str,
    data_type: &str,
    nullable: bool,
    default: Option<&str>,
) -> ColumnEdit {
    ColumnEdit {
        original_name: original.map(|s| s.to_string()),
        name: name.into(),
        data_type: data_type.into(),
        nullable,
        default: default.map(|s| s.to_string()),
        is_primary_key: false,
    }
}

#[tokio::test]
async fn alter_plan_add_column() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let change = DesignerChange {
        columns: vec![
            // keep existing 4 columns unchanged
            edit(Some("id"), "id", "INTEGER", true, None),
            edit(Some("name"), "name", "TEXT", false, None),
            edit(Some("age"), "age", "INTEGER", true, None),
            edit(Some("email"), "email", "TEXT", true, None),
            // add a new column
            edit(None, "nickname", "TEXT", true, None),
        ],
    };
    let plan = alter::generate_alter(&pool, None, "users", &change)
        .await
        .expect("plan");
    assert!(
        plan.statements
            .iter()
            .any(|s| s.contains("ADD COLUMN") && s.contains("\"nickname\"")),
        "expected ADD COLUMN nickname, got: {:?}",
        plan.statements
    );
}

#[tokio::test]
async fn alter_plan_rename_column() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let change = DesignerChange {
        columns: vec![
            edit(Some("id"), "id", "INTEGER", true, None),
            // rename name -> full_name
            edit(Some("name"), "full_name", "TEXT", false, None),
            edit(Some("age"), "age", "INTEGER", true, None),
            edit(Some("email"), "email", "TEXT", true, None),
        ],
    };
    let plan = alter::generate_alter(&pool, None, "users", &change)
        .await
        .expect("plan");
    assert!(
        plan.statements
            .iter()
            .any(|s| s.contains("RENAME COLUMN")
                && s.contains("\"name\"")
                && s.contains("\"full_name\"")),
        "expected RENAME COLUMN, got {:?}",
        plan.statements
    );
}

#[tokio::test]
async fn alter_plan_drop_column() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    // omit email to request drop
    let change = DesignerChange {
        columns: vec![
            edit(Some("id"), "id", "INTEGER", true, None),
            edit(Some("name"), "name", "TEXT", false, None),
            edit(Some("age"), "age", "INTEGER", true, None),
        ],
    };
    let plan = alter::generate_alter(&pool, None, "users", &change)
        .await
        .expect("plan");
    assert!(
        plan.statements
            .iter()
            .any(|s| s.contains("DROP COLUMN") && s.contains("\"email\"")),
        "expected DROP COLUMN email, got {:?}",
        plan.statements
    );
}

#[tokio::test]
async fn alter_plan_sqlite_type_change_produces_warning() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    // change age's type/nullable/default -> should produce warning, no ALTER stmt for this col
    let change = DesignerChange {
        columns: vec![
            edit(Some("id"), "id", "INTEGER", true, None),
            edit(Some("name"), "name", "TEXT", false, None),
            edit(Some("age"), "age", "BIGINT", false, Some("0")),
            edit(Some("email"), "email", "TEXT", true, None),
        ],
    };
    let plan = alter::generate_alter(&pool, None, "users", &change)
        .await
        .expect("plan");
    assert!(
        !plan.warnings.is_empty(),
        "expected warnings for SQLite type/nullable/default change, got plan={:?}",
        plan
    );
    // ensure no ALTER COLUMN TYPE style statement was emitted for 'age' on SQLite
    for s in &plan.statements {
        assert!(
            !(s.contains("ALTER COLUMN") && s.contains("\"age\"")),
            "SQLite should not emit ALTER COLUMN for type change: {}",
            s
        );
        assert!(
            !s.contains("MODIFY COLUMN"),
            "SQLite should not emit MODIFY COLUMN: {}",
            s
        );
    }
}

#[tokio::test]
async fn apply_statements_add_column_visible_via_describe() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let stmts =
        vec!["ALTER TABLE \"users\" ADD COLUMN \"nickname\" TEXT".to_string()];
    let applied = alter::apply_statements(&pool, &stmts)
        .await
        .expect("apply");
    assert_eq!(applied.len(), 1);

    let cols = meta::list_columns(&pool, None, "users")
        .await
        .expect("list_columns");
    assert!(
        cols.iter().any(|c| c.name == "nickname"),
        "new column not visible: {:?}",
        cols
    );
}
