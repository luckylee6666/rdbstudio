//! SQLite table copies stay inside one write transaction and never decode rows.
use super::{
    cancelled, fingerprint, CopyPhase, CopyPlan, CopyReport, NativeCopyRequest, ProgressFn,
};
use crate::error::{AppError, AppResult};
use sqlx::{
    Connection, Row, Sqlite, SqliteConnection, SqlitePool, Transaction, TransactionManager,
};
use std::collections::HashSet;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct Snapshot {
    plan: CopyPlan,
    create: Vec<String>,
    insert: String,
    sequence: Vec<String>,
}

fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn validate(request: &NativeCopyRequest) -> AppResult<()> {
    if request
        .schema
        .as_deref()
        .is_some_and(|schema| !schema.eq_ignore_ascii_case("main"))
    {
        return Err(AppError::msg(
            "SQLite native copy only supports the main schema",
        ));
    }
    for name in [&request.source_table, &request.target_table] {
        if name.is_empty() || name.contains('\0') {
            return Err(AppError::msg(
                "table names must be nonempty and contain no NUL",
            ));
        }
        if name.to_ascii_lowercase().starts_with("sqlite_") {
            return Err(AppError::msg("SQLite internal tables cannot be copied"));
        }
    }
    if request
        .source_table
        .eq_ignore_ascii_case(&request.target_table)
    {
        return Err(AppError::msg("source and target tables must differ"));
    }
    Ok(())
}

pub async fn preview(pool: &SqlitePool, request: &NativeCopyRequest) -> AppResult<CopyPlan> {
    validate(request)?;
    // Read all schema metadata from the same snapshot, even when another
    // connection changes the schema while this preview is being assembled.
    let mut tx = pool.begin().await?;
    let snapshot = inspect(&mut tx, request).await?;
    tx.rollback().await?;
    Ok(snapshot.plan)
}

// Dropping an executing future must not leave a cancelled progress callback on
// a pooled connection. The callback becomes inert before Transaction is dropped.
struct InterruptScope(Arc<AtomicBool>);

impl Drop for InterruptScope {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub async fn execute(
    pool: &SqlitePool,
    request: &NativeCopyRequest,
    expected: &str,
    cancel: CancellationToken,
    progress: ProgressFn,
) -> AppResult<CopyReport> {
    validate(request)?;
    check_cancel(&cancel)?;
    progress(CopyPhase::Preparing);
    let mut connection = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(cancelled()),
        acquired = pool.acquire() => acquired?,
    };
    // Acquire the write reservation before checking the fingerprint or target.
    // This makes both schema checks and all copied rows one execution snapshot.
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    let interrupt_scope = InterruptScope(Arc::new(AtomicBool::new(true)));
    let active = interrupt_scope.0.clone();
    let interrupted = cancel.clone();
    tx.lock_handle().await?.set_progress_handler(1000, move || {
        !active.load(Ordering::Acquire) || !interrupted.is_cancelled()
    });

    let result = async {
        check_cancel(&cancel)?;
        let snapshot = inspect(&mut tx, request).await?;
        if snapshot.plan.fingerprint != expected {
            return Err(AppError::msg(
                "source schema or copy plan changed; preview the table copy again",
            ));
        }
        check_cancel(&cancel)?;
        progress(CopyPhase::Creating);
        for statement in &snapshot.create {
            check_cancel(&cancel)?;
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        check_cancel(&cancel)?;
        progress(CopyPhase::Copying);
        let rows_copied = sqlx::query(&snapshot.insert)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        check_cancel(&cancel)?;
        progress(CopyPhase::Finishing);
        for statement in &snapshot.sequence {
            check_cancel(&cancel)?;
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        check_cancel(&cancel)?;
        Ok(CopyReport { rows_copied })
    }
    .await;

    // Await the SQLite worker before removing its handler and rolling back;
    // cancelling just the Rust query future can leave the write running.
    tx.lock_handle().await?.remove_progress_handler();
    drop(interrupt_scope);
    match result {
        Ok(report) if !cancel.is_cancelled() => {
            // Keep the Transaction available on a failed COMMIT (e.g. a
            // deferred foreign key) so rollback completes before we return.
            if let Err(error) = sqlx::sqlite::SqliteTransactionManager::commit(&mut tx).await {
                rollback(tx).await?;
                return Err(error.into());
            }
            // The manager already committed and set depth = 0. This no-op
            // closes the RAII transaction without queuing another rollback.
            tx.commit().await?;
            Ok(report)
        }
        other => {
            if cancel.is_cancelled() {
                progress(CopyPhase::Cancelling);
            }
            rollback(tx).await?;
            if cancel.is_cancelled() {
                Err(cancelled())
            } else {
                other
            }
        }
    }
}

fn check_cancel(cancel: &CancellationToken) -> AppResult<()> {
    if cancel.is_cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}

async fn rollback(mut tx: Transaction<'_, Sqlite>) -> AppResult<()> {
    let in_transaction = {
        let mut handle = tx.lock_handle().await?;
        // SAFETY: SQLx's locked handle keeps the connection alive and excludes
        // worker access during this synchronous SQLite state query, as in
        // sessions.rs. No raw pointer escapes this guard.
        unsafe { libsqlite3_sys::sqlite3_get_autocommit(handle.as_raw_handle().as_ptr()) == 0 }
    };
    if !in_transaction {
        // SQLITE_INTERRUPT can already have rolled the SQLite transaction back.
        // SQLx 0.8.6 still has transaction_depth = 1 in that case. Give its
        // rollback an empty transaction so its depth is reset as well. Closing
        // this connection instead could destroy a single-connection :memory: DB.
        sqlx::query("BEGIN").execute(&mut *tx).await?;
    }
    tx.rollback().await?;
    Ok(())
}

async fn inspect(
    connection: &mut SqliteConnection,
    request: &NativeCopyRequest,
) -> AppResult<Snapshot> {
    let source = sqlx::query(
        "SELECT name, sql FROM main.sqlite_schema \
         WHERE type = 'table' AND name = ? COLLATE NOCASE",
    )
    .bind(&request.source_table)
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| AppError::msg("source must be an existing ordinary SQLite table"))?;
    let source_name: String = source.try_get("name")?;
    let source_sql: Option<String> = source.try_get("sql")?;
    let source_sql = source_sql.ok_or_else(|| AppError::msg("source table has no CREATE SQL"))?;
    let table = sqlx::query(
        "SELECT type, wr FROM pragma_table_list WHERE schema = 'main' AND name = ? COLLATE NOCASE",
    )
    .bind(&source_name)
    .fetch_one(&mut *connection)
    .await?;
    if table.try_get::<String, _>("type")? != "table" {
        return Err(AppError::msg(
            "SQLite native copy does not support virtual or shadow tables",
        ));
    }
    let without_rowid = table.try_get::<i64, _>("wr")? != 0;
    let occupied: Vec<String> =
        sqlx::query_scalar("SELECT name FROM main.sqlite_schema ORDER BY name")
            .fetch_all(&mut *connection)
            .await?;
    let mut occupied: HashSet<String> = occupied
        .into_iter()
        .map(|name| name.to_ascii_lowercase())
        .collect();
    if !occupied.insert(request.target_table.to_ascii_lowercase()) {
        return Err(AppError::msg(
            "target table or schema object already exists",
        ));
    }

    let foreign_keys =
        sqlx::query("SELECT * FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq")
            .bind(&source_name)
            .fetch_all(&mut *connection)
            .await?;
    for key in foreign_keys {
        let target: String = key.try_get("table")?;
        if target.eq_ignore_ascii_case(&source_name) {
            return Err(AppError::msg(
                "SQLite native copy does not support self-referencing foreign keys",
            ));
        }
    }

    let columns = sqlx::query(
        "SELECT name, type, pk, hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid",
    )
    .bind(&source_name)
    .fetch_all(&mut *connection)
    .await?;
    let mut writable = Vec::new();
    let mut declared_names = HashSet::new();
    let mut primary_key_types = Vec::new();
    for column in columns {
        let name: String = column.try_get("name")?;
        declared_names.insert(name.to_ascii_lowercase());
        if column.try_get::<i64, _>("hidden")? == 0 {
            writable.push(name);
        }
        if column.try_get::<i64, _>("pk")? > 0 {
            primary_key_types.push(column.try_get::<String, _>("type")?);
        }
    }
    if writable.is_empty() {
        return Err(AppError::msg("source table has no writable columns"));
    }
    let mut warnings = Vec::new();
    if !without_rowid {
        // An INTEGER PRIMARY KEY aliases rowid except for the column-level
        // PRIMARY KEY DESC quirk. The latter has an actual primary-key index;
        // table-level PRIMARY KEY(id DESC) still aliases rowid and has none.
        let has_primary_key_index: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_index_list(?, 'main') WHERE origin = 'pk'",
        )
        .bind(&source_name)
        .fetch_one(&mut *connection)
        .await?;
        let has_declared_rowid_alias = primary_key_types.len() == 1
            && primary_key_types[0].eq_ignore_ascii_case("INTEGER")
            && has_primary_key_index == 0;
        if !has_declared_rowid_alias {
            if let Some(alias) = ["rowid", "_rowid_", "oid"]
                .into_iter()
                .find(|alias| !declared_names.contains(*alias))
            {
                // Preserve sparse, negative and zero rowids as well as all
                // declared values. Generated columns can shadow aliases too.
                writable.insert(0, alias.to_string());
            } else {
                warnings.push(
                    "All hidden rowid aliases (rowid, _rowid_, oid) are shadowed by declared \
                     columns; declared values are copied, but hidden rowids may change"
                        .into(),
                );
            }
        }
    }
    let create_table = rewrite_table(&source_sql, &source_name, &request.target_table)?;
    let mut create = vec![create_table];
    let mut source_metadata = vec![source_name.clone(), source_sql.clone()];
    let indexes = sqlx::query(
        "SELECT name, sql FROM main.sqlite_schema \
         WHERE type = 'index' AND tbl_name = ? COLLATE NOCASE AND sql IS NOT NULL ORDER BY name",
    )
    .bind(&source_name)
    .fetch_all(&mut *connection)
    .await?;
    for (ordinal, index) in indexes.into_iter().enumerate() {
        let name: String = index.try_get("name")?;
        let sql: String = index.try_get("sql")?;
        let base = format!("{}_copy_idx_{}", request.target_table, ordinal + 1);
        let mut target_name = base.clone();
        let mut suffix = 2usize;
        while !occupied.insert(target_name.to_ascii_lowercase()) {
            target_name = format!("{base}_{suffix}");
            suffix += 1;
        }
        create.push(rewrite_index(
            &sql,
            &name,
            &source_name,
            &target_name,
            &request.target_table,
        )?);
        source_metadata.extend([name, sql]);
    }

    let triggers = sqlx::query(
        "SELECT name, sql FROM main.sqlite_schema \
         WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE ORDER BY name",
    )
    .bind(&source_name)
    .fetch_all(&mut *connection)
    .await?;
    if !triggers.is_empty() {
        warnings.push(format!(
            "{} source trigger(s) are not copied",
            triggers.len()
        ));
    }
    for trigger in triggers {
        source_metadata.push(trigger.try_get("name")?);
        source_metadata.push(
            trigger
                .try_get::<Option<String>, _>("sql")?
                .unwrap_or_default(),
        );
    }
    let column_list = writable
        .iter()
        .map(|name| ident(name))
        .collect::<Vec<_>>()
        .join(", ");
    let insert = format!(
        "INSERT OR ABORT INTO main.{} ({column_list}) SELECT {column_list} FROM main.{}",
        ident(&request.target_table),
        ident(&source_name),
    );

    // sqlite_sequence can be higher than MAX(id), e.g. after deleting the last
    // row. Copy that high-water mark, including for an empty source table.
    let sequence = if tokenize(&source_sql)?
        .iter()
        .any(|token| token.keyword("AUTOINCREMENT"))
    {
        let source = literal(&source_name);
        let target = literal(&request.target_table);
        vec![
            format!(
                "UPDATE main.sqlite_sequence SET seq = MAX(seq, \
                 COALESCE((SELECT MAX(seq) FROM main.sqlite_sequence WHERE name = {source}), seq)) \
                 WHERE name = {target}"
            ),
            format!(
                "INSERT INTO main.sqlite_sequence (name, seq) \
                 SELECT {target}, seq FROM main.sqlite_sequence WHERE name = {source} \
                 AND NOT EXISTS (SELECT 1 FROM main.sqlite_sequence WHERE name = {target})"
            ),
        ]
    } else {
        Vec::new()
    };
    let statements: Vec<String> = create
        .iter()
        .cloned()
        .chain(std::iter::once(insert.clone()))
        .chain(sequence.iter().cloned())
        .collect();
    // Row values/counts and sequence values deliberately do not enter this
    // fingerprint: execution copies the current, locked snapshot of the data.
    let fingerprint = fingerprint(&serde_json::to_string(&(&source_metadata, &statements))?);
    Ok(Snapshot {
        plan: CopyPlan {
            fingerprint,
            statements,
            warnings,
            transactional: true,
        },
        create,
        insert,
        sequence,
    })
}

#[derive(Debug)]
struct Token {
    span: Range<usize>,
    value: String,
    quoted: bool,
}

impl Token {
    fn keyword(&self, word: &str) -> bool {
        !self.quoted && self.value.eq_ignore_ascii_case(word)
    }

    fn symbol(&self, symbol: &str) -> bool {
        !self.quoted && self.value == symbol
    }
}

// A lexer rather than a text replacement keeps quoted values, expressions,
// defaults and comments intact when remapping CREATE identifiers.
fn tokenize(sql: &str) -> AppResult<Vec<Token>> {
    let bytes = sql.as_bytes();
    let mut cursor = 0;
    let mut tokens = Vec::new();
    while cursor < bytes.len() {
        if bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
            continue;
        }
        if bytes[cursor..].starts_with(b"--") {
            while cursor < bytes.len() && bytes[cursor] != b'\n' {
                cursor += 1;
            }
            continue;
        }
        if bytes[cursor..].starts_with(b"/*") {
            cursor += 2;
            while cursor + 1 < bytes.len() && &bytes[cursor..cursor + 2] != b"*/" {
                cursor += 1;
            }
            if cursor + 1 >= bytes.len() {
                return Err(AppError::msg("unclosed comment in SQLite CREATE SQL"));
            }
            cursor += 2;
            continue;
        }
        let start = cursor;
        if matches!(bytes[cursor], b'\'' | b'"' | b'`' | b'[') {
            let opener = bytes[cursor];
            let closer = if opener == b'[' { b']' } else { opener };
            cursor += 1;
            let content_start = cursor;
            let mut closed = false;
            while cursor < bytes.len() {
                if bytes[cursor] == closer {
                    if opener != b'[' && bytes.get(cursor + 1) == Some(&closer) {
                        cursor += 2;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    cursor += 1;
                }
            }
            if !closed {
                return Err(AppError::msg("unclosed quote in SQLite CREATE SQL"));
            }
            let value = sql[content_start..cursor].replace(
                &format!("{}{}", closer as char, closer as char),
                &(closer as char).to_string(),
            );
            cursor += 1;
            tokens.push(Token {
                span: start..cursor,
                value,
                quoted: true,
            });
        } else if bytes[cursor].is_ascii_punctuation()
            && bytes[cursor] != b'_'
            && bytes[cursor] != b'$'
        {
            cursor += 1;
            tokens.push(Token {
                span: start..cursor,
                value: sql[start..cursor].into(),
                quoted: false,
            });
        } else {
            cursor += 1;
            while cursor < bytes.len()
                && !bytes[cursor].is_ascii_whitespace()
                && (!bytes[cursor].is_ascii_punctuation() || matches!(bytes[cursor], b'_' | b'$'))
            {
                cursor += 1;
            }
            tokens.push(Token {
                span: start..cursor,
                value: sql[start..cursor].into(),
                quoted: false,
            });
        }
    }
    if tokens
        .iter()
        .position(|token| token.symbol(";"))
        .is_some_and(|position| position + 1 != tokens.len())
    {
        return Err(AppError::msg(
            "SQLite CREATE SQL must contain exactly one statement",
        ));
    }
    Ok(tokens)
}

struct Header<'a> {
    tokens: &'a [Token],
    position: usize,
}

impl Header<'_> {
    fn take(&mut self, keyword: &str) -> bool {
        if self
            .tokens
            .get(self.position)
            .is_some_and(|token| token.keyword(keyword))
        {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, keyword: &str) -> AppResult<()> {
        if self.take(keyword) {
            Ok(())
        } else {
            Err(AppError::msg("unsupported SQLite CREATE statement header"))
        }
    }

    fn optional_if_not_exists(&mut self) -> AppResult<()> {
        if self.take("IF") {
            self.expect("NOT")?;
            self.expect("EXISTS")?;
        }
        Ok(())
    }

    fn name(&mut self, expected: &str) -> AppResult<Range<usize>> {
        let first = self
            .tokens
            .get(self.position)
            .ok_or_else(|| AppError::msg("missing SQLite CREATE object name"))?;
        self.position += 1;
        let last = if self
            .tokens
            .get(self.position)
            .is_some_and(|token| token.symbol("."))
        {
            if !first.value.eq_ignore_ascii_case("main") {
                return Err(AppError::msg(
                    "SQLite native copy only supports main schema objects",
                ));
            }
            self.position += 1;
            let name = self
                .tokens
                .get(self.position)
                .ok_or_else(|| AppError::msg("missing qualified SQLite object name"))?;
            self.position += 1;
            name
        } else {
            first
        };
        if !last.value.eq_ignore_ascii_case(expected) {
            return Err(AppError::msg(
                "SQLite CREATE object name does not match schema metadata",
            ));
        }
        Ok(first.span.start..last.span.end)
    }

    fn expect_body(&self) -> AppResult<()> {
        if self
            .tokens
            .get(self.position)
            .is_some_and(|token| token.symbol("("))
        {
            Ok(())
        } else {
            Err(AppError::msg("unsupported SQLite CREATE statement body"))
        }
    }
}

fn rewrite_table(sql: &str, source: &str, target: &str) -> AppResult<String> {
    let tokens = tokenize(sql)?;
    let mut header = Header {
        tokens: &tokens,
        position: 0,
    };
    header.expect("CREATE")?;
    header.expect("TABLE")?;
    header.optional_if_not_exists()?;
    let name = header.name(source)?;
    header.expect_body()?;
    let mut result = sql.to_string();
    // SQLite permits CHECK(source.column) and CHECK(main.source.column).
    // Remap the table qualifier while leaving a schema qualifier alone (the
    // source table itself can be named "main"). Other expression contexts do
    // not allow qualified references to other tables in a CREATE TABLE.
    for position in (header.position + 1..tokens.len()).rev() {
        let token = &tokens[position];
        if token.value.eq_ignore_ascii_case(source)
            && tokens
                .get(position + 1)
                .is_some_and(|token| token.symbol("."))
            && !tokens
                .get(position + 3)
                .is_some_and(|token| token.symbol("."))
        {
            result.replace_range(token.span.clone(), &ident(target));
        }
    }
    result.replace_range(name, &format!("main.{}", ident(target)));
    Ok(result)
}

fn rewrite_index(
    sql: &str,
    source_index: &str,
    source_table: &str,
    target_index: &str,
    target_table: &str,
) -> AppResult<String> {
    let tokens = tokenize(sql)?;
    let mut header = Header {
        tokens: &tokens,
        position: 0,
    };
    header.expect("CREATE")?;
    header.take("UNIQUE");
    header.expect("INDEX")?;
    header.optional_if_not_exists()?;
    let index = header.name(source_index)?;
    header.expect("ON")?;
    let table = header.name(source_table)?;
    header.expect_body()?;
    let mut result = sql.to_string();
    result.replace_range(table, &ident(target_table));
    result.replace_range(index, &format!("main.{}", ident(target_index)));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    fn request(source: &str, target: &str) -> NativeCopyRequest {
        NativeCopyRequest {
            schema: Some("main".into()),
            source_table: source.into(),
            target_table: target.into(),
        }
    }

    fn silent() -> ProgressFn {
        Arc::new(|_| {})
    }

    async fn copy(pool: &SqlitePool, request: &NativeCopyRequest) -> CopyReport {
        let plan = preview(pool, request).await.unwrap();
        execute(
            pool,
            request,
            &plan.fingerprint,
            CancellationToken::new(),
            silent(),
        )
        .await
        .unwrap()
    }

    async fn exists(pool: &SqlitePool, name: &str) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_schema WHERE name = ?")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap()
            != 0
    }

    #[tokio::test]
    async fn copies_twelve_thousand_duplicate_rows_without_a_primary_key() {
        let pool = pool().await;
        sqlx::query("CREATE TABLE source (n INTEGER, data BLOB, memo TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 12000) \
             INSERT INTO source SELECT 9007199254740993 + i % 2, X'00FF80', NULL FROM n",
        )
        .execute(&pool)
        .await
        .unwrap();
        let report = copy(&pool, &request("source", "target")).await;
        assert_eq!(report.rows_copied, 12000);
        let groups: Vec<(i64, Vec<u8>, Option<String>, i64)> = sqlx::query_as(
            "SELECT n, data, memo, COUNT(*) FROM target GROUP BY n, data, memo ORDER BY n",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            groups,
            vec![
                (9007199254740993, vec![0, 255, 128], None, 6000),
                (9007199254740994, vec![0, 255, 128], None, 6000),
            ]
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM source")
                .fetch_one(&pool)
                .await
                .unwrap(),
            12000
        );
    }

    #[tokio::test]
    async fn preserves_sparse_negative_and_zero_rowids_even_when_one_alias_is_shadowed() {
        let pool = pool().await;
        sqlx::query("CREATE TABLE source (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO source(rowid, value) VALUES (-11, 'negative'), (0, 'zero'), (900, 'sparse')")
            .execute(&pool).await.unwrap();
        copy(&pool, &request("source", "target")).await;
        let copied: Vec<(i64, String)> =
            sqlx::query_as("SELECT rowid, value FROM target ORDER BY rowid")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            copied,
            vec![
                (-11, "negative".into()),
                (0, "zero".into()),
                (900, "sparse".into())
            ]
        );

        sqlx::query("CREATE TABLE shadow_source (\"RoWiD\" TEXT, value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO shadow_source(_rowid_, rowid, value) VALUES (-11, 'column a', 'negative'), (0, 'column b', 'zero'), (900, 'column c', 'sparse')")
            .execute(&pool).await.unwrap();
        let shadow = request("shadow_source", "shadow_target");
        let plan = preview(&pool, &shadow).await.unwrap();
        assert!(plan.warnings.is_empty());
        assert!(plan
            .statements
            .iter()
            .any(|statement| statement.starts_with("INSERT OR ABORT")
                && statement.contains("(\"_rowid_\", \"RoWiD\", \"value\")")));
        execute(
            &pool,
            &shadow,
            &plan.fingerprint,
            CancellationToken::new(),
            silent(),
        )
        .await
        .unwrap();
        let copied: Vec<(i64, String)> =
            sqlx::query_as("SELECT _rowid_, rowid FROM shadow_target ORDER BY _rowid_")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            copied,
            vec![
                (-11, "column a".into()),
                (0, "column b".into()),
                (900, "column c".into())
            ]
        );
    }

    #[tokio::test]
    async fn distinguishes_integer_primary_key_aliases_from_primary_key_desc() {
        let pool = pool().await;
        for (source, target, declaration, aliases_rowid) in [
            ("plain_pk", "plain_copy", "id INTEGER PRIMARY KEY", true),
            ("desc_pk", "desc_copy", "id INTEGER PRIMARY KEY DESC", false),
            (
                "table_pk",
                "table_copy",
                "id INTEGER, PRIMARY KEY(id DESC)",
                true,
            ),
        ] {
            sqlx::query(&format!("CREATE TABLE {source} ({declaration})"))
                .execute(&pool)
                .await
                .unwrap();
            if aliases_rowid {
                sqlx::query(&format!(
                    "INSERT INTO {source}(id) VALUES (-11), (0), (900)"
                ))
                .execute(&pool)
                .await
                .unwrap();
            } else {
                sqlx::query(&format!(
                    "INSERT INTO {source}(rowid, id) VALUES (-11, 1), (0, 2), (900, 3)"
                ))
                .execute(&pool)
                .await
                .unwrap();
            }
            copy(&pool, &request(source, target)).await;
            let original: Vec<(i64, i64)> =
                sqlx::query_as(&format!("SELECT rowid, id FROM {source} ORDER BY rowid"))
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let copied: Vec<(i64, i64)> =
                sqlx::query_as(&format!("SELECT rowid, id FROM {target} ORDER BY rowid"))
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(copied, original, "{declaration}");
            assert_eq!(
                copied.iter().map(|row| row.0).collect::<Vec<_>>(),
                [-11, 0, 900]
            );
        }
    }

    #[tokio::test]
    async fn warns_when_all_hidden_rowid_aliases_are_shadowed_unless_a_primary_key_preserves_them()
    {
        let pool = pool().await;
        sqlx::query("CREATE TABLE source (rowid TEXT, _rowid_ TEXT, oid TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO source VALUES ('visible rowid', 'visible _rowid_', 'visible oid')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let all_shadowed = request("source", "target");
        let plan = preview(&pool, &all_shadowed).await.unwrap();
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("hidden rowids may change"));
        execute(
            &pool,
            &all_shadowed,
            &plan.fingerprint,
            CancellationToken::new(),
            silent(),
        )
        .await
        .unwrap();
        let copied: (String, String, String) =
            sqlx::query_as("SELECT rowid, _rowid_, oid FROM target")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            copied,
            (
                "visible rowid".into(),
                "visible _rowid_".into(),
                "visible oid".into()
            )
        );

        sqlx::query(
            "CREATE TABLE source_pk (id INTEGER PRIMARY KEY, rowid TEXT, _rowid_ TEXT, oid TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO source_pk(id) VALUES (900)")
            .execute(&pool)
            .await
            .unwrap();
        let with_pk = request("source_pk", "target_pk");
        let plan = preview(&pool, &with_pk).await.unwrap();
        assert!(plan.warnings.is_empty());
        execute(
            &pool,
            &with_pk,
            &plan.fingerprint,
            CancellationToken::new(),
            silent(),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT id FROM target_pk")
                .fetch_one(&pool)
                .await
                .unwrap(),
            900
        );
    }

    #[tokio::test]
    async fn preserves_constraints_generated_columns_partial_expression_indexes_and_sequence() {
        let pool = pool().await;
        sqlx::query(
            "CREATE TABLE \"source table\" (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             amount INTEGER NOT NULL CHECK (main.\"source table\".amount >= 0), \
             label TEXT NOT NULL DEFAULT 'source table', \
             computed INTEGER GENERATED ALWAYS AS (amount * 2) STORED UNIQUE) STRICT",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE INDEX \"expression index\" ON \"source table\" \
             ((lower(label) || 'source table')) WHERE amount > 2",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO \"source table\" (id, amount) VALUES (1, 3), (2, 4), (100, 5)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM \"source table\" WHERE id = 100")
            .execute(&pool)
            .await
            .unwrap();
        let request = request("source table", "copy \"target");
        let plan = preview(&pool, &request).await.unwrap();
        assert!(plan.transactional);
        assert!(plan.statements[0].contains("DEFAULT 'source table'"));
        assert!(plan.statements[1].contains("((lower(label) || 'source table')) WHERE amount > 2"));
        assert!(!plan
            .statements
            .iter()
            .find(|statement| statement.starts_with("INSERT OR ABORT"))
            .unwrap()
            .contains("computed"));
        execute(
            &pool,
            &request,
            &plan.fingerprint,
            CancellationToken::new(),
            silent(),
        )
        .await
        .unwrap();
        let target = ident(&request.target_table);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT computed FROM {target} WHERE id = 2"))
                .fetch_one(&pool)
                .await
                .unwrap(),
            8
        );
        sqlx::query(&format!("INSERT INTO {target} (amount) VALUES (6)"))
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT MAX(id) FROM {target}"))
                .fetch_one(&pool)
                .await
                .unwrap(),
            101
        );
        assert!(
            sqlx::query(&format!("INSERT INTO {target} (amount) VALUES (-1)"))
                .execute(&pool)
                .await
                .is_err()
        );
        assert!(
            sqlx::query(&format!("INSERT INTO {target} (amount) VALUES (3)"))
                .execute(&pool)
                .await
                .is_err()
        );
        assert!(sqlx::query(&format!(
            "INSERT INTO {target} (amount) VALUES ('not an integer')"
        ))
        .execute(&pool)
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT seq FROM sqlite_sequence WHERE name = 'source table'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            100
        );
    }

    #[tokio::test]
    async fn preserves_without_rowid_external_foreign_key_and_warns_about_triggers() {
        let pool = pool().await;
        sqlx::query("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO parent VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE source (parent INTEGER REFERENCES parent(id), key TEXT, \
             PRIMARY KEY (parent, key)) WITHOUT ROWID, STRICT",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TRIGGER source_trigger AFTER INSERT ON source BEGIN SELECT 1; END")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO source VALUES (1, 'key')")
            .execute(&pool)
            .await
            .unwrap();
        let request = request("source", "target");
        let plan = preview(&pool, &request).await.unwrap();
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.statements[0].ends_with("WITHOUT ROWID, STRICT"));
        execute(
            &pool,
            &request,
            &plan.fingerprint,
            CancellationToken::new(),
            silent(),
        )
        .await
        .unwrap();
        assert!(sqlx::query("SELECT rowid FROM target")
            .fetch_one(&pool)
            .await
            .is_err());
        assert!(
            sqlx::query("INSERT INTO target VALUES (2, 'bad foreign key')")
                .execute(&pool)
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'target'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn preserves_sequence_even_if_source_is_empty() {
        let pool = pool().await;
        sqlx::query("CREATE TABLE source (id INTEGER PRIMARY KEY AUTOINCREMENT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO source VALUES (100)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM source")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            copy(&pool, &request("source", "target")).await.rows_copied,
            0
        );
        sqlx::query("INSERT INTO target DEFAULT VALUES")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT id FROM target")
                .fetch_one(&pool)
                .await
                .unwrap(),
            101
        );
    }

    #[tokio::test]
    async fn remaps_qualified_checks_when_the_source_table_is_named_main() {
        let pool = pool().await;
        sqlx::query(
            "CREATE TABLE main (value INTEGER CHECK (main.main.value > 0), \
             text TEXT DEFAULT 'main.main.value')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO main(value) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        copy(&pool, &request("main", "target")).await;
        assert!(sqlx::query("INSERT INTO target(value) VALUES (-1)")
            .execute(&pool)
            .await
            .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT text FROM target")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "main.main.value"
        );
    }

    #[tokio::test]
    async fn rejects_existing_target_and_schema_changes_but_allows_new_source_rows() {
        let pool = pool().await;
        sqlx::query("CREATE TABLE source (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        let request = request("source", "target");
        let plan = preview(&pool, &request).await.unwrap();
        sqlx::query("CREATE TABLE target (sentinel TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO target VALUES ('keep me')")
            .execute(&pool)
            .await
            .unwrap();
        assert!(preview(&pool, &request).await.is_err());
        assert!(execute(
            &pool,
            &request,
            &plan.fingerprint,
            CancellationToken::new(),
            silent()
        )
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT sentinel FROM target")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "keep me"
        );

        let fresh = super::tests::request("source", "fresh");
        let stale = preview(&pool, &fresh).await.unwrap();
        sqlx::query("CREATE INDEX source_index ON source(value)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(execute(
            &pool,
            &fresh,
            &stale.fingerprint,
            CancellationToken::new(),
            silent()
        )
        .await
        .is_err());
        assert!(!exists(&pool, "fresh").await);
        let current = preview(&pool, &fresh).await.unwrap();
        sqlx::query("INSERT INTO source VALUES ('arrived after preview')")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            execute(
                &pool,
                &fresh,
                &current.fingerprint,
                CancellationToken::new(),
                silent()
            )
            .await
            .unwrap()
            .rows_copied,
            1
        );
    }

    #[tokio::test]
    async fn cancels_the_sqlite_vm_rolls_back_and_reuses_the_only_memory_connection() {
        let pool = pool().await;
        sqlx::query("CREATE TABLE source (value INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 12000) \
             INSERT INTO source SELECT i FROM n",
        )
        .execute(&pool)
        .await
        .unwrap();
        let request = request("source", "cancelled_copy");
        let plan = preview(&pool, &request).await.unwrap();
        let cancel = CancellationToken::new();
        let callback_cancel = cancel.clone();
        let progress: ProgressFn = Arc::new(move |phase| {
            if matches!(phase, CopyPhase::Copying) {
                callback_cancel.cancel();
            }
        });
        assert!(
            execute(&pool, &request, &plan.fingerprint, cancel, progress)
                .await
                .is_err()
        );
        assert!(!exists(&pool, "cancelled_copy").await);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM source")
                .fetch_one(&pool)
                .await
                .unwrap(),
            12000
        );
        // A new transaction also proves SQLx's depth did not remain stale after
        // SQLite automatically rolled back the interrupted INSERT.
        assert_eq!(copy(&pool, &request).await.rows_copied, 12000);
    }

    #[tokio::test]
    async fn rolls_back_copy_and_failed_commit_constraints_without_losing_the_source() {
        let pool = pool().await;
        sqlx::query("CREATE TABLE source (value INTEGER CHECK (value > 0))")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA ignore_check_constraints = ON")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO source VALUES (-1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA ignore_check_constraints = OFF")
            .execute(&pool)
            .await
            .unwrap();
        let request = request("source", "target");
        let plan = preview(&pool, &request).await.unwrap();
        assert!(execute(
            &pool,
            &request,
            &plan.fingerprint,
            CancellationToken::new(),
            silent()
        )
        .await
        .is_err());
        assert!(!exists(&pool, "target").await);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT value FROM source")
                .fetch_one(&pool)
                .await
                .unwrap(),
            -1
        );

        sqlx::query("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE deferred_source (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)")
            .execute(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO deferred_source VALUES (42)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        let request = super::tests::request("deferred_source", "deferred_target");
        let plan = preview(&pool, &request).await.unwrap();
        assert!(execute(
            &pool,
            &request,
            &plan.fingerprint,
            CancellationToken::new(),
            silent()
        )
        .await
        .is_err());
        assert!(!exists(&pool, "deferred_target").await);
        sqlx::query("INSERT INTO parent VALUES (42)")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(copy(&pool, &request).await.rows_copied, 1);
    }

    #[tokio::test]
    async fn rejects_self_foreign_keys_views_virtual_tables_and_other_schemas() {
        let pool = pool().await;
        sqlx::query("CREATE TABLE self_ref (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES self_ref(id))")
            .execute(&pool).await.unwrap();
        let error = preview(&pool, &request("self_ref", "target"))
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("self-referencing"));
        sqlx::query("CREATE VIEW view_source AS SELECT * FROM self_ref")
            .execute(&pool)
            .await
            .unwrap();
        assert!(preview(&pool, &request("view_source", "view_copy"))
            .await
            .is_err());
        sqlx::query("CREATE VIRTUAL TABLE virtual_source USING fts5(content)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(preview(&pool, &request("virtual_source", "virtual_copy"))
            .await
            .is_err());
        assert!(
            preview(&pool, &request("virtual_source_data", "shadow_copy"))
                .await
                .is_err()
        );
        let mut other_schema = request("self_ref", "target");
        other_schema.schema = Some("temp".into());
        assert!(preview(&pool, &other_schema).await.is_err());
    }

    #[test]
    fn rewrites_ddl_identifiers_without_touching_literals_or_comments() {
        let sql = "CREATE /* keep */ TABLE IF NOT EXISTS main.[source] (value TEXT DEFAULT 'source', \"source\" INT CHECK (\"source\" >= 0))";
        assert_eq!(rewrite_table(sql, "source", "target\"").unwrap(),
            "CREATE /* keep */ TABLE IF NOT EXISTS main.\"target\"\"\" (value TEXT DEFAULT 'source', \"source\" INT CHECK (\"source\" >= 0))");
        let sql = "CREATE UNIQUE INDEX IF NOT EXISTS main.`source``index` ON 'source' (lower('source') || value) WHERE value <> 'source'";
        assert_eq!(rewrite_index(sql, "source`index", "source", "new index", "target").unwrap(),
            "CREATE UNIQUE INDEX IF NOT EXISTS main.\"new index\" ON \"target\" (lower('source') || value) WHERE value <> 'source'");
        assert!(rewrite_table(
            "CREATE TABLE source (value TEXT); DROP TABLE source",
            "source",
            "target"
        )
        .is_err());
        assert!(rewrite_table(
            "CREATE TABLE source (value TEXT DEFAULT ';'); -- tail",
            "source",
            "target"
        )
        .is_ok());
    }
}
