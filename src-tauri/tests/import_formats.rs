mod common;

use rdbstudio_lib::db::{
    exec,
    imports::{import_file, preview_file, ImportFileOptions},
    io::ImportMode,
};
use serde_json::json;

#[tokio::test]
async fn json_import_preserves_null_empty_and_big_integer_and_rolls_back_errors() {
    let pool = common::mem_pool().await;
    exec::execute(
        &pool,
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT, n INTEGER)",
    )
    .await
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.json");
    std::fs::write(
        &path,
        r#"[{"id":1,"value":null,"n":9223372036854775807},{"id":2,"value":"","n":7}]"#,
    )
    .unwrap();
    let preview = preview_file(path.to_str().unwrap(), None, true).unwrap();
    let mapping = preview.preview.headers.unwrap();
    let options = ImportFileOptions {
        path: path.to_string_lossy().into(),
        schema: None,
        table: "items".into(),
        mode: ImportMode::Append,
        column_map: mapping,
        sheet: None,
        has_header: true,
    };
    assert_eq!(import_file(&pool, &options).await.unwrap().rows_inserted, 2);
    let result = exec::execute(&pool, "SELECT id,value,n FROM items ORDER BY id")
        .await
        .unwrap();
    assert_eq!(
        result.rows,
        vec![
            vec![json!(1), json!(null), json!("9223372036854775807")],
            vec![json!(2), json!(""), json!(7)]
        ]
    );
    std::fs::write(
        &path,
        r#"[{"id":3,"value":"will rollback","n":7},{"id":3,"value":"duplicate","n":7}]"#,
    )
    .unwrap();
    let replace = ImportFileOptions {
        mode: ImportMode::TruncateInsert,
        ..options
    };
    assert!(import_file(&pool, &replace).await.is_err());
    assert_eq!(
        exec::execute(&pool, "SELECT count(*) FROM items")
            .await
            .unwrap()
            .rows[0][0],
        2
    );
}

#[test]
fn xml_import_decodes_text_and_rejects_dtd_and_duplicate_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.xml");
    std::fs::write(&path, "<rows><row><id>1</id><value>A &amp; B</value><empty></empty><field name=\"absent\" null=\"true\"></field></row></rows>").unwrap();
    let preview = preview_file(path.to_str().unwrap(), None, true)
        .unwrap()
        .preview;
    let columns = preview.headers.unwrap();
    assert_eq!(
        preview.sample_rows[0][columns.iter().position(|c| c == "value").unwrap()],
        "A & B"
    );
    assert_eq!(
        preview.sample_rows[0][columns.iter().position(|c| c == "empty").unwrap()],
        ""
    );
    assert_eq!(
        preview.sample_rows[0][columns.iter().position(|c| c == "absent").unwrap()],
        "NULL"
    );
    for invalid in [
        "<!DOCTYPE rows [<!ENTITY x SYSTEM 'file:///private/file'>]><rows/>",
        "<rows><row><value>a</value><value>b</value></row></rows>",
    ] {
        std::fs::write(&path, invalid).unwrap();
        assert!(preview_file(path.to_str().unwrap(), None, true).is_err());
    }
}

#[tokio::test]
async fn binary_edit_roundtrips_bytes_and_invalid_input_rolls_back() {
    use rdbstudio_lib::db::data::{apply_edits, Edit, EditBatch};
    let pool = common::mem_pool().await;
    exec::execute(
        &pool,
        "CREATE TABLE images(id INTEGER PRIMARY KEY, payload BLOB)",
    )
    .await
    .unwrap();
    let batch = EditBatch {
        schema: None,
        table: "images".into(),
        edits: vec![Edit::Insert {
            values: vec![
                ("id".into(), json!(1)),
                ("payload".into(), json!({"$binary":"AP8B"})),
            ],
        }],
    };
    assert!(apply_edits(&pool, &batch).await.unwrap().ok);
    assert_eq!(
        exec::execute(&pool, "SELECT hex(payload) AS bytes FROM images")
            .await
            .unwrap()
            .rows[0][0],
        "00FF01"
    );
    let invalid = EditBatch {
        edits: vec![Edit::Update {
            pk: vec![("id".into(), json!(1))],
            set: vec![("payload".into(), json!({"$binary":"invalid !!!"}))],
        }],
        ..batch
    };
    assert!(apply_edits(&pool, &invalid).await.is_err());
    assert_eq!(
        exec::execute(&pool, "SELECT hex(payload) AS bytes FROM images")
            .await
            .unwrap()
            .rows[0][0],
        "00FF01"
    );
}

#[tokio::test]
async fn excel_import_reads_worksheet_and_uses_the_same_atomic_mapping() {
    let pool = common::mem_pool().await;
    exec::execute(
        &pool,
        "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)",
    )
    .await
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book.xlsx");
    std::fs::write(&path, include_bytes!("fixtures/import.xlsx")).unwrap();
    let preview = preview_file(path.to_str().unwrap(), Some("Data"), true).unwrap();
    assert_eq!(preview.sheets, ["Data"]);
    assert_eq!(preview.preview.headers.unwrap(), ["id", "name"]);
    assert_eq!(preview.preview.sample_rows[0][1], "Alice & Bob");
    let options = ImportFileOptions {
        path: path.to_string_lossy().into(),
        schema: None,
        table: "users".into(),
        mode: ImportMode::Append,
        column_map: vec!["id".into(), "name".into()],
        sheet: Some("Data".into()),
        has_header: true,
    };
    assert_eq!(import_file(&pool, &options).await.unwrap().rows_inserted, 2);
    assert_eq!(
        exec::execute(&pool, "SELECT name FROM users WHERE id=1")
            .await
            .unwrap()
            .rows[0][0],
        "Alice & Bob"
    );
}

#[tokio::test]
async fn binary_marker_in_a_json_column_remains_json_and_default_rows_can_be_inserted() {
    use rdbstudio_lib::db::data::{apply_edits, Edit, EditBatch};
    let pool = common::mem_pool().await;
    exec::execute(
        &pool,
        "CREATE TABLE docs(id INTEGER PRIMARY KEY, value JSON DEFAULT '{}')",
    )
    .await
    .unwrap();
    let batch = EditBatch {
        schema: None,
        table: "docs".into(),
        edits: vec![
            Edit::Insert {
                values: vec![("value".into(), json!({"$binary":"AP8B"}))],
            },
            Edit::Insert { values: vec![] },
        ],
    };
    assert!(apply_edits(&pool, &batch).await.unwrap().ok);
    let rows = exec::execute(
        &pool,
        "SELECT typeof(value) AS kind, CAST(value AS TEXT) AS value FROM docs ORDER BY id",
    )
    .await
    .unwrap()
    .rows;
    assert_eq!(rows[0], vec![json!("text"), json!(r#"{"$binary":"AP8B"}"#)]);
    assert_eq!(rows[1], vec![json!("text"), json!("{}")]);
}
