mod common;

use rdbstudio_lib::db::io::{
    self, ExportFormat, ExportOptions, ImportCsvOptions, ImportMode,
};

fn csv_opts(path: &str) -> ExportOptions {
    ExportOptions {
        format: ExportFormat::Csv,
        path: path.into(),
        delimiter: ',',
        include_header: true,
        quote_all: false,
        batch_size: 1000,
    }
}

#[tokio::test]
async fn export_csv_and_preview() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
    // keep path, drop the handle to avoid Windows-style sharing issues
    let path = tmp.path().to_path_buf();
    drop(tmp);

    let opts = csv_opts(path.to_str().unwrap());
    let report = io::export_table(&pool, None, "users", &opts)
        .await
        .expect("export");
    assert_eq!(report.rows_written, 3, "expected 3 rows");

    let content = std::fs::read_to_string(&path).expect("read csv");
    // header line + 3 data lines -> at least 4 newlines worth of content
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 4, "got lines: {:?}", lines);
    // header should contain id, name, age, email
    let header = lines[0];
    assert!(header.contains("id"));
    assert!(header.contains("name"));
    assert!(header.contains("age"));
    assert!(header.contains("email"));

    // preview_csv reads back
    let preview = io::preview_csv(path.to_str().unwrap(), ',', true, 5).expect("preview");
    let headers = preview.headers.expect("headers");
    assert!(headers.contains(&"name".to_string()));
    assert_eq!(preview.sample_rows.len(), 3);
    assert_eq!(preview.total_sampled, 3);
}

#[tokio::test]
async fn import_csv_append_mode() {
    let pool = common::mem_pool().await;

    // Create an empty target table
    let sqlite = match &pool {
        rdbstudio_lib::db::pool::DbPool::Sqlite(p) => p,
        _ => unreachable!(),
    };
    sqlx::query("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)")
        .execute(sqlite)
        .await
        .expect("create table");

    // Write a CSV with header + 2 rows
    let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
    let path = tmp.path().to_path_buf();
    drop(tmp);
    std::fs::write(
        &path,
        "id,name,age\n1,Alice,30\n2,Bob,25\n",
    )
    .expect("write csv");

    let opts = ImportCsvOptions {
        path: path.to_string_lossy().into_owned(),
        schema: None,
        table: "people".into(),
        delimiter: ',',
        has_header: true,
        mode: ImportMode::Append,
        column_map: None,
    };
    let report = io::import_csv(&pool, &opts).await.expect("import");
    assert_eq!(
        report.rows_inserted, 2,
        "expected 2 rows inserted (errors={:?})",
        report.errors
    );
    assert_eq!(report.rows_read, 2);
    assert!(report.errors.is_empty(), "errors: {:?}", report.errors);

    // verify count
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM people")
        .fetch_one(sqlite)
        .await
        .unwrap();
    assert_eq!(n, 2);
}

#[tokio::test]
async fn export_json_parses_back_as_array() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
    let path = tmp.path().to_path_buf();
    drop(tmp);

    let opts = ExportOptions {
        format: ExportFormat::Json,
        path: path.to_string_lossy().into_owned(),
        delimiter: ',',
        include_header: true,
        quote_all: false,
        batch_size: 1000,
    };
    io::export_table(&pool, None, "users", &opts)
        .await
        .expect("export");

    let text = std::fs::read_to_string(&path).expect("read json");
    let v: serde_json::Value = serde_json::from_str(&text).expect("parse json");
    let arr = v.as_array().expect("array");
    assert_eq!(arr.len(), 3);
    for item in arr {
        assert!(item.is_object());
        let obj = item.as_object().unwrap();
        assert!(obj.contains_key("id"));
        assert!(obj.contains_key("name"));
    }
}

#[tokio::test]
async fn export_sql_includes_insert_into_users() {
    let pool = common::mem_pool().await;
    common::seed_users(&pool).await;

    let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
    let path = tmp.path().to_path_buf();
    drop(tmp);

    let opts = ExportOptions {
        format: ExportFormat::Sql,
        path: path.to_string_lossy().into_owned(),
        delimiter: ',',
        include_header: false,
        quote_all: false,
        batch_size: 1000,
    };
    io::export_table(&pool, None, "users", &opts)
        .await
        .expect("export");

    let text = std::fs::read_to_string(&path).expect("read sql");
    assert!(
        text.contains("INSERT INTO \"users\""),
        "unexpected SQL: {}",
        text
    );
    // should have 3 insert lines
    let count = text.matches("INSERT INTO").count();
    assert_eq!(count, 3, "expected 3 INSERT lines, got: {}", text);
}
