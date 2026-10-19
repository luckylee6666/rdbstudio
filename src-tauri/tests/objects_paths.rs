use rdbstudio_lib::db::{objects, pool::DbPool};
use rdbstudio_lib::error::AppResult;
use rdbstudio_lib::model::DriverKind;

fn suffix() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..10].to_string()
}

#[tokio::test]
async fn table_scoped_catalog_returns_only_exact_table_triggers() {
    use sqlx::sqlite::SqlitePoolOptions;

    let sqlite = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let pool = DbPool::Sqlite(sqlite.clone());
    for table in ["scope_alpha", "scope_beta"] {
        sqlx::query(&format!("CREATE TABLE {table} (id INTEGER)"))
            .execute(&sqlite)
            .await
            .unwrap();
        sqlx::query(&format!(
            "CREATE TRIGGER trg_{table} AFTER INSERT ON {table} BEGIN SELECT 1; END"
        ))
        .execute(&sqlite)
        .await
        .unwrap();
    }

    let scoped = objects::list_managed_objects_scoped(&pool, None, Some("scope_alpha"))
        .await
        .unwrap();
    assert_eq!(scoped.objects.len(), 1);
    assert_eq!(scoped.objects[0].name, "trg_scope_alpha");
    assert_eq!(scoped.objects[0].table.as_deref(), Some("scope_alpha"));
    assert!(scoped.users.is_empty());
    assert_eq!(scoped.supported, ["trigger"]);

    let schema_catalog = objects::list_managed_objects(&pool, None).await.unwrap();
    assert_eq!(schema_catalog.objects.len(), 2);
    assert!(schema_catalog.supported.contains(&"index".to_string()));
    sqlite.close().await;
}

#[tokio::test]
async fn postgres_object_management_paths() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_POSTGRES_URL") else {
        eprintln!("skip postgres object paths: RDBSTUDIO_TEST_POSTGRES_URL is not set");
        return;
    };
    let tag = suffix();
    let schema = format!("rdbstudio_obj_{tag}");
    let role = format!("rdbstudio_u_{tag}");
    let pool = DbPool::connect(DriverKind::Postgres, &url).await.unwrap();
    let DbPool::Postgres(pg) = &pool else {
        unreachable!()
    };
    let setup: AppResult<()> = async {
        sqlx::query(&format!("CREATE SCHEMA \"{schema}\"" )).execute(pg).await?;
        sqlx::query(&format!("CREATE TABLE \"{schema}\".parent (a INT, b INT, PRIMARY KEY(a,b))" )).execute(pg).await?;
        sqlx::query(&format!("CREATE TABLE \"{schema}\".child (id INT PRIMARY KEY, x INT, y INT, note TEXT)" )).execute(pg).await?;

        let create = objects::IndexChange::Create { name: format!("idx_{tag}"), columns: vec!["note".into()], unique: false, method: Some("btree".into()), prefix_lengths: vec![] };
        objects::apply_index_change(&pool, Some(&schema), "child", &create).await?;
        let replace = objects::IndexChange::Replace { old_name: format!("idx_{tag}"), name: format!("idx_{tag}"), columns: vec!["x".into(), "y".into()], unique: true, method: Some("btree".into()), prefix_lengths: vec![] };
        objects::apply_index_change(&pool, Some(&schema), "child", &replace).await?;

        let fk = objects::ForeignKeyDefinition { name: format!("fk_{tag}"), columns: vec!["x".into(), "y".into()], referenced_schema: Some(schema.clone()), referenced_table: "parent".into(), referenced_columns: vec!["a".into(), "b".into()], on_update: Some("CASCADE".into()), on_delete: Some("RESTRICT".into()) };
        objects::apply_foreign_key_changes(&pool, Some(&schema), "child", std::slice::from_ref(&fk)).await?;
        let listed = objects::list_index_metadata(&pool, Some(&schema), "child").await?;
        assert!(listed.iter().any(|i| i.name == format!("idx_{tag}") && i.is_unique && i.columns == ["x", "y"]));
        let fks = rdbstudio_lib::db::design::describe(&pool, Some(&schema), "child").await?.foreign_keys;
        assert_eq!(fks.len(), 1);
        assert_eq!(fks[0].columns, ["x", "y"]);

        let function = format!("CREATE FUNCTION \"{schema}\".\"f_{tag}\"(v integer) RETURNS integer LANGUAGE SQL IMMUTABLE AS $$ SELECT v + 1 $$");
        objects::apply_object_definition(&pool, &function, None).await?;
        let procedure = format!("CREATE PROCEDURE \"{schema}\".\"p_{tag}\"() LANGUAGE SQL AS $$ SELECT 1 $$");
        objects::apply_object_definition(&pool, &procedure, None).await?;
        let trigger_function = format!("CREATE FUNCTION \"{schema}\".\"tr_fn_{tag}\"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
        objects::apply_object_definition(&pool, &trigger_function, None).await?;
        let trigger = format!("CREATE TRIGGER \"tr_{tag}\" BEFORE UPDATE ON \"{schema}\".child FOR EACH ROW EXECUTE FUNCTION \"{schema}\".\"tr_fn_{tag}\"()");
        objects::apply_object_definition(&pool, &trigger, None).await?;
        let other_trigger = format!("CREATE TRIGGER \"tr_other_{tag}\" BEFORE UPDATE ON \"{schema}\".parent FOR EACH ROW EXECUTE FUNCTION \"{schema}\".\"tr_fn_{tag}\"()");
        objects::apply_object_definition(&pool, &other_trigger, None).await?;
        let catalog = objects::list_managed_objects(&pool, Some(&schema)).await?;
        let routine = catalog.objects.iter().find(|o| o.name == format!("f_{tag}")).unwrap();
        assert!(routine.drop_sql.as_deref().unwrap().contains("(v integer)"), "overload-safe DROP must use the server-reported identity signature");
        assert!(catalog.objects.iter().any(|o| o.name == format!("tr_{tag}") && o.kind == "trigger"));
        let scoped = objects::list_managed_objects_scoped(&pool, Some(&schema), Some("child")).await?;
        assert_eq!(scoped.objects.len(), 1);
        assert_eq!(scoped.objects[0].name, format!("tr_{tag}"));
        assert!(scoped.users.is_empty());
        assert_eq!(scoped.supported, ["trigger"]);
        let overload = format!("CREATE FUNCTION \"{schema}\".\"f_{tag}\"(v text) RETURNS text LANGUAGE SQL IMMUTABLE AS $$ SELECT v $$");
        objects::apply_object_definition(&pool, &overload, None).await?;
        objects::apply_object_definition(&pool, "unused", routine.drop_sql.as_deref()).await?;
        let retained: String = sqlx::query_scalar(&format!("SELECT \"{schema}\".\"f_{tag}\"('kept'::text)")).fetch_one(pg).await?;
        assert_eq!(retained, "kept", "dropping one overload must leave the other intact");

        objects::apply_user(&pool, &role, None, Some("temporary-test-password"), false).await?;
        objects::apply_scoped_grants(&pool, &role, None, &schema, None, &["USAGE".into()], true, Some("schema")).await?;
        objects::apply_grants(&pool, &role, None, &schema, Some("child"), &["SELECT".into()], true).await?;
        let mut read_as_role = pg.begin().await?;
        sqlx::query(&format!("SET LOCAL ROLE \"{role}\"")).execute(&mut *read_as_role).await?;
        sqlx::query(&format!("SELECT * FROM \"{schema}\".child")).fetch_all(&mut *read_as_role).await?;
        read_as_role.rollback().await?;
        let catalog = objects::list_managed_objects(&pool, Some(&schema)).await?;
        assert!(catalog.users.iter().find(|u| u.name == role).is_some_and(|u| u.grants.iter().any(|g| g.contains("child") && g.contains("SELECT"))));
        objects::apply_grants(&pool, &role, None, &schema, Some("child"), &["SELECT".into()], false).await?;
        objects::apply_scoped_grants(&pool, &role, None, &schema, None, &["USAGE".into()], false, Some("schema")).await?;
        assert!(objects::apply_grants(&pool, &role, None, &schema, Some("child"), &["CONNECT".into()], true).await.is_err());
        Ok(())
    }.await;
    let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"))
        .execute(pg)
        .await;
    let _ = objects::apply_user(&pool, &role, None, None, true).await;
    pool.close().await;
    setup.unwrap();
}

#[tokio::test]
async fn mysql_object_management_paths() {
    let Ok(url) = std::env::var("RDBSTUDIO_TEST_MYSQL_SCRATCH_URL") else {
        eprintln!("skip mysql object paths: RDBSTUDIO_TEST_MYSQL_SCRATCH_URL is not set");
        return;
    };
    let tag = suffix();
    let role = format!("rdbstudio_u_{tag}");
    let host = "localhost";
    let pool = DbPool::connect(DriverKind::Mysql, &url).await.unwrap();
    let DbPool::Mysql(mysql) = &pool else {
        unreachable!()
    };
    let schema: String = sqlx::query_scalar("SELECT DATABASE()")
        .fetch_one(mysql)
        .await
        .unwrap();
    let parent = format!("rdbstudio_p_{tag}");
    let child = format!("rdbstudio_c_{tag}");
    let function = format!("rdbstudio_f_{tag}");
    let procedure = format!("rdbstudio_proc_{tag}");
    let trigger = format!("rdbstudio_tr_{tag}");
    let other_trigger = format!("rdbstudio_tr_other_{tag}");
    let setup: AppResult<()> = async {
        sqlx::query(&format!("CREATE TABLE `{parent}` (a INT NOT NULL, b INT NOT NULL, PRIMARY KEY(a,b)) ENGINE=InnoDB")).execute(mysql).await?;
        sqlx::query(&format!("CREATE TABLE `{child}` (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, x INT, y INT, note VARCHAR(255), payload TEXT) ENGINE=InnoDB")).execute(mysql).await?;
        let text_index = objects::IndexChange::Create { name: format!("idx_text_{tag}"), columns: vec!["payload".into()], unique: false, method: Some("BTREE".into()), prefix_lengths: vec![Some(191)] };
        objects::apply_index_change(&pool, Some(&schema), &child, &text_index).await?;
        let prefix: Option<i64> = sqlx::query_scalar("SELECT sub_part FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=?")
            .bind(&schema).bind(&child).bind(format!("idx_text_{tag}")).fetch_one(mysql).await?;
        assert_eq!(prefix, Some(191));
        objects::apply_index_change(&pool, Some(&schema), &child, &objects::IndexChange::Drop { name: format!("idx_text_{tag}") }).await?;
        let create = objects::IndexChange::Create { name: format!("idx_{tag}"), columns: vec!["note".into()], unique: false, method: Some("BTREE".into()), prefix_lengths: vec![None] };
        objects::apply_index_change(&pool, Some(&schema), &child, &create).await?;
        let replace = objects::IndexChange::Replace { old_name: format!("idx_{tag}"), name: format!("idx_{tag}"), columns: vec!["x".into(), "y".into()], unique: true, method: Some("BTREE".into()), prefix_lengths: vec![None, None] };
        objects::apply_index_change(&pool, Some(&schema), &child, &replace).await?;
        let fk = objects::ForeignKeyDefinition { name: format!("fk_{tag}"), columns: vec!["x".into(), "y".into()], referenced_schema: Some(schema.clone()), referenced_table: parent.clone(), referenced_columns: vec!["a".into(), "b".into()], on_update: Some("CASCADE".into()), on_delete: Some("RESTRICT".into()) };
        objects::apply_foreign_key_changes(&pool, Some(&schema), &child, &[fk]).await?;
        let indexes = objects::list_index_metadata(&pool, Some(&schema), &child).await?;
        assert!(indexes.iter().any(|i| i.name == format!("idx_{tag}") && i.is_unique && i.columns == ["x", "y"]));

        objects::apply_object_definition(&pool, &format!("CREATE FUNCTION `{function}`(v INT) RETURNS INT DETERMINISTIC RETURN v + 1"), None).await?;
        objects::apply_object_definition(&pool, &format!("CREATE PROCEDURE `{procedure}`() BEGIN SELECT 1; SELECT 2; END"), None).await?;
        objects::apply_object_definition(&pool, &format!("CREATE TRIGGER `{trigger}` BEFORE UPDATE ON `{child}` FOR EACH ROW BEGIN SET @rdbstudio_object_test = 1; SET @rdbstudio_object_test = 2; END"), None).await?;
        objects::apply_object_definition(&pool, &format!("CREATE TRIGGER `{other_trigger}` BEFORE UPDATE ON `{parent}` FOR EACH ROW BEGIN SET @rdbstudio_object_test = 3; END"), None).await?;
        let catalog = objects::list_managed_objects(&pool, Some(&schema)).await?;
        assert!(catalog.objects.iter().find(|o| o.name == function).and_then(|o| o.definition.as_deref()).is_some_and(|d| d.contains("FUNCTION") && d.contains("CREATE")));
        assert!(catalog.objects.iter().find(|o| o.name == procedure).and_then(|o| o.definition.as_deref()).is_some_and(|d| d.contains("PROCEDURE") && d.contains("CREATE")));
        assert!(catalog.objects.iter().find(|o| o.name == trigger).and_then(|o| o.definition.as_deref()).is_some_and(|d| d.contains("TRIGGER") && d.contains("CREATE")));
        let scoped = objects::list_managed_objects_scoped(&pool, Some(&schema), Some(&child)).await?;
        assert_eq!(scoped.objects.len(), 1);
        assert_eq!(scoped.objects[0].name, trigger);
        assert!(scoped.users.is_empty());
        assert_eq!(scoped.supported, ["trigger"]);
        // The tree supplies server-reported names, so the scoped catalog must
        // not expand their matches through information_schema collation.
        let other_case = objects::list_managed_objects_scoped(&pool, Some(&schema), Some(&child.to_uppercase())).await?;
        assert!(other_case.objects.is_empty());
        let other_schema_case = objects::list_managed_objects_scoped(&pool, Some(&schema.to_uppercase()), Some(&child)).await?;
        assert!(other_schema_case.objects.is_empty());

        objects::apply_user(&pool, &role, Some(host), Some("temporary-test-password"), false).await?;
        objects::apply_grants(&pool, &role, Some(host), &schema, Some(&child), &["SELECT".into()], true).await?;
        let catalog = objects::list_managed_objects(&pool, Some(&schema)).await?;
        assert!(catalog.users.iter().find(|u| u.name == role && u.host.as_deref() == Some(host)).is_some_and(|u| u.grants.iter().any(|g| g.contains(&child) && g.contains("SELECT"))));
        objects::apply_grants(&pool, &role, Some(host), &schema, Some(&child), &["SELECT".into()], false).await?;
        assert!(objects::apply_grants(&pool, &role, Some(host), &schema, Some(&child), &["TRUNCATE".into()], true).await.is_err());
        Ok(())
    }.await;
    let _ = objects::apply_user(&pool, &role, Some(host), None, true).await;
    for (kind, name) in [
        ("TRIGGER", &trigger),
        ("TRIGGER", &other_trigger),
        ("PROCEDURE", &procedure),
        ("FUNCTION", &function),
    ] {
        let _ = sqlx::raw_sql(&format!("DROP {kind} IF EXISTS `{name}`"))
            .execute(mysql)
            .await;
    }
    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS `{child}`"))
        .execute(mysql)
        .await;
    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS `{parent}`"))
        .execute(mysql)
        .await;
    pool.close().await;
    setup.unwrap();
}
