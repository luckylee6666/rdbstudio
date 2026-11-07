//! Query tabs own their SQL connection until reset, close or disconnect.
use crate::db::exec::{self, QueryResult, RollbackState, ScriptOutcome};
use crate::db::parameters::QueryParameter;
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::Serialize;
use sqlx::Connection;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

const MAX_SESSIONS: usize = 32;
const MAX_STATEMENTS: usize = 128;

pub struct ParameterExecution<'a> {
    pub parameters: &'a [QueryParameter],
    pub atomic: bool,
}

pub struct ParameterBatchExecution<'a> {
    pub sets: &'a [Vec<QueryParameter>],
    pub atomic: bool,
}

pub(crate) struct ExecutionOptions<'a> {
    pub parameters: Option<&'a [QueryParameter]>,
    pub atomic: bool,
    pub readonly: bool,
    pub source: bool,
    pub batch: Option<crate::db::parameter_batch::Execution<'a>>,
}

pub enum EditorConnection {
    Sqlite(sqlx::SqliteConnection),
    Postgres(sqlx::PgConnection),
    Mysql(sqlx::MySqlConnection),
}

impl EditorConnection {
    async fn acquire(pool: &DbPool) -> AppResult<Self> {
        Ok(match pool {
            DbPool::Sqlite(p) => Self::Sqlite(p.acquire().await?.detach()),
            DbPool::Postgres(p) => Self::Postgres(p.acquire().await?.detach()),
            DbPool::Mysql(p) => Self::Mysql(p.acquire().await?.detach()),
            DbPool::Redis(_) => return Err(AppError::msg("Redis has no SQL session")),
        })
    }
    async fn ping(&mut self) -> bool {
        match self {
            Self::Sqlite(c) => c.ping().await.is_ok(),
            Self::Postgres(c) => c.ping().await.is_ok(),
            Self::Mysql(c) => c.ping().await.is_ok(),
        }
    }
    async fn close(self) {
        match self {
            Self::Sqlite(c) => {
                let _ = c.close().await;
            }
            Self::Postgres(c) => {
                let _ = c.close().await;
            }
            Self::Mysql(c) => {
                let _ = c.close().await;
            }
        }
    }
}

#[derive(Default)]
struct Slot {
    connection: Option<EditorConnection>,
    initialized: bool,
    in_transaction: bool,
    manual_commit_mode: bool,
}
struct Session {
    identity: String,
    connection_id: String,
    slot: Arc<AsyncMutex<Slot>>,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Session>>,
    plan_sessions: HashMap<String, Arc<Session>>,
    closed_connections: HashSet<String>,
    generations: HashMap<String, u64>,
}

#[derive(Default)]
pub struct EditorSessions {
    registry: Mutex<Registry>,
    sqlite_anchors: Mutex<HashMap<String, sqlx::SqliteConnection>>,
}

#[derive(Serialize)]
pub struct SessionStatus {
    pub connected: bool,
    pub in_transaction: bool,
    pub needs_reset: bool,
}

struct QueryInterrupt(CancellationToken);
impl Drop for QueryInterrupt {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl EditorSessions {
    /// Snapshot the active generation before a query command clones its pool.
    /// A pool captured before disconnect/reconnect is rejected by `execute`.
    pub fn lease(&self, id: &str) -> AppResult<u64> {
        let mut registry = self.registry.lock();
        if registry.closed_connections.contains(id) {
            return Err(AppError::msg("connection is disconnecting"));
        }
        Ok(*registry.generations.entry(id.to_owned()).or_insert(1))
    }

    /// Mark a newly inserted pool as the active connection generation.
    pub fn mark_connected(&self, id: &str) -> u64 {
        let mut registry = self.registry.lock();
        registry.closed_connections.remove(id);
        let generation = registry.generations.entry(id.to_owned()).or_insert(0);
        *generation = generation.wrapping_add(1).max(1);
        *generation
    }

    fn is_generation_current(&self, id: &str, generation: u64) -> bool {
        let registry = self.registry.lock();
        !registry.closed_connections.contains(id)
            && registry.generations.get(id).copied().unwrap_or(1) == generation
    }

    async fn ensure_sqlite_anchor(
        &self,
        id: &str,
        generation: u64,
        session: &Session,
        pool: &sqlx::SqlitePool,
    ) -> AppResult<()> {
        if self.sqlite_anchors.lock().contains_key(id) {
            if self.is_generation_current(id, generation) {
                return Ok(());
            }
            return Err(AppError::msg(
                "connection changed while starting this query; run it again",
            ));
        }
        let pooled = tokio::select! {
            _ = session.cancel.cancelled() => return Err(AppError::msg("editor session closed")),
            result = pool.acquire() => result?,
        };
        let anchor = pooled.detach();
        let mut anchor = Some(anchor);
        let accepted = {
            let registry = self.registry.lock();
            if registry.closed_connections.contains(id)
                || registry.generations.get(id).copied().unwrap_or(1) != generation
            {
                false
            } else {
                let mut anchors = self.sqlite_anchors.lock();
                anchors
                    .entry(id.to_owned())
                    .or_insert_with(|| anchor.take().expect("anchor is present"));
                true
            }
        };
        if !accepted {
            if let Some(anchor) = anchor {
                let _ = anchor.close().await;
            }
            return Err(AppError::msg(
                "connection changed while starting this query; run it again",
            ));
        }
        Ok(())
    }

    fn get_or_create(
        &self,
        id: &str,
        session_id: &str,
        generation: u64,
    ) -> AppResult<Arc<Session>> {
        if session_id.is_empty() || session_id.len() > 256 {
            return Err(AppError::msg("invalid editor session id"));
        }
        let mut registry = self.registry.lock();
        if registry.closed_connections.contains(id)
            || registry.generations.get(id).copied().unwrap_or(1) != generation
        {
            return Err(AppError::msg(
                "connection changed while starting this query; run it again",
            ));
        }
        if let Some(session) = registry.plan_sessions.get(session_id) {
            if session.connection_id != id || session.cancel.is_cancelled() {
                return Err(AppError::msg(
                    "source query session changed or closed; open a new plan from the query tab",
                ));
            }
            return Ok(Arc::clone(session));
        }
        if let Some(session) = registry.sessions.get(session_id) {
            if session.connection_id != id {
                return Err(AppError::msg(
                    "reset the editor session before changing connections",
                ));
            }
            return Ok(Arc::clone(session));
        }
        if session_id.starts_with("explain:") || session_id.starts_with("explain-analyze:") {
            return Err(AppError::msg(
                "source query session changed or closed; open a new plan from the query tab",
            ));
        }
        if registry.sessions.len() >= MAX_SESSIONS {
            return Err(AppError::msg(
                "32 editor sessions are open; close or reset an unused query tab",
            ));
        }
        let session = Arc::new(Session {
            identity: uuid::Uuid::new_v4().to_string(),
            connection_id: id.to_owned(),
            slot: Arc::new(AsyncMutex::new(Slot::default())),
            cancel: CancellationToken::new(),
        });
        registry
            .sessions
            .insert(session_id.to_owned(), Arc::clone(&session));
        Ok(session)
    }

    /// Capture a particular source session at the explicit query-tab action.
    /// Attaching later never creates a replacement for a closed/reset source.
    pub fn identity(&self, id: &str, source_id: &str, generation: u64) -> AppResult<String> {
        Ok(self
            .get_or_create(id, source_id, generation)?
            .identity
            .clone())
    }

    /// A plan shares the query connection while owning only a child cancel
    /// token. Closing an idle plan must never close or roll back its source.
    pub fn attach_plan(
        &self,
        id: &str,
        source_id: &str,
        plan_id: &str,
        generation: u64,
        identity: &str,
    ) -> AppResult<()> {
        if plan_id.is_empty() || plan_id.len() > 256 || plan_id == source_id {
            return Err(AppError::msg("invalid plan session id"));
        }
        let mut registry = self.registry.lock();
        let source = registry.sessions.get(source_id).cloned().ok_or_else(|| {
            AppError::msg(
                "source query session changed or closed; open a new plan from the query tab",
            )
        })?;
        if source.identity != identity
            || source.connection_id != id
            || source.cancel.is_cancelled()
            || registry.closed_connections.contains(id)
            || registry.generations.get(id).copied().unwrap_or(1) != generation
            || !registry
                .sessions
                .get(source_id)
                .is_some_and(|current| Arc::ptr_eq(current, &source))
        {
            return Err(AppError::msg(
                "source query session changed or closed; open a new plan from the query tab",
            ));
        }
        if registry.sessions.contains_key(plan_id) {
            return Err(AppError::msg("plan id belongs to another editor session"));
        }
        if let Some(existing) = registry.plan_sessions.get(plan_id) {
            if existing.cancel.is_cancelled() || !Arc::ptr_eq(&existing.slot, &source.slot) {
                return Err(AppError::msg(
                    "source query session changed or closed; open a new plan from the query tab",
                ));
            }
            return Ok(());
        }
        if registry.plan_sessions.len() >= 128 {
            return Err(AppError::msg(
                "128 plans are open; close an unused plan tab",
            ));
        }
        registry.plan_sessions.insert(
            plan_id.to_owned(),
            Arc::new(Session {
                identity: uuid::Uuid::new_v4().to_string(),
                connection_id: id.to_owned(),
                slot: Arc::clone(&source.slot),
                cancel: source.cancel.child_token(),
            }),
        );
        Ok(())
    }

    pub async fn execute(
        &self,
        id: &str,
        session_id: &str,
        generation: u64,
        pool: &DbPool,
        statements: &[String],
        atomic: bool,
    ) -> AppResult<ScriptOutcome> {
        self.execute_with_options(
            id,
            session_id,
            generation,
            pool,
            statements,
            ExecutionOptions {
                parameters: None,
                atomic,
                readonly: false,
                source: false,
                batch: None,
            },
        )
        .await
    }

    pub async fn execute_parameterized(
        &self,
        id: &str,
        session_id: &str,
        generation: u64,
        pool: &DbPool,
        statements: &[String],
        options: ParameterExecution<'_>,
    ) -> AppResult<ScriptOutcome> {
        self.execute_with_options(
            id,
            session_id,
            generation,
            pool,
            statements,
            ExecutionOptions {
                parameters: Some(options.parameters),
                atomic: options.atomic,
                readonly: false,
                source: false,
                batch: None,
            },
        )
        .await
    }

    pub async fn execute_source(
        &self,
        id: &str,
        session_id: &str,
        generation: u64,
        pool: &DbPool,
        source: &str,
        options: ParameterExecution<'_>,
    ) -> AppResult<ScriptOutcome> {
        crate::db::sql_script::validate_source(source)?;
        self.execute_with_options(
            id,
            session_id,
            generation,
            pool,
            &[source.to_owned()],
            ExecutionOptions {
                parameters: Some(options.parameters),
                atomic: options.atomic,
                readonly: false,
                source: true,
                batch: None,
            },
        )
        .await
    }

    pub async fn execute_batch(
        &self,
        id: &str,
        session_id: &str,
        generation: u64,
        pool: &DbPool,
        source: &str,
        options: ParameterBatchExecution<'_>,
    ) -> AppResult<crate::db::parameter_batch::Outcome> {
        let ParameterBatchExecution { sets, atomic } = options;
        let mut progress = crate::db::parameter_batch::Progress::default();
        let outcome = self
            .execute_with_options(
                id,
                session_id,
                generation,
                pool,
                &[source.to_owned()],
                ExecutionOptions {
                    parameters: None,
                    atomic,
                    readonly: false,
                    source: true,
                    batch: Some(crate::db::parameter_batch::Execution {
                        sets,
                        progress: &mut progress,
                    }),
                },
            )
            .await?;
        Ok(crate::db::parameter_batch::Outcome { outcome, progress })
    }

    pub(crate) async fn execute_with_options(
        &self,
        id: &str,
        session_id: &str,
        generation: u64,
        pool: &DbPool,
        statements: &[String],
        options: ExecutionOptions<'_>,
    ) -> AppResult<ScriptOutcome> {
        if statements.is_empty() || statements.len() > MAX_STATEMENTS {
            return Err(AppError::msg(
                "scripts must contain between 1 and 128 statements",
            ));
        }
        if !options.source && statements.iter().any(|s| !exec::is_single_statement(s)) {
            return Err(AppError::msg(
                "each script item must contain one SQL statement",
            ));
        }
        if !options.source
            && options.readonly
            && options.parameters.is_none()
            && statements.iter().any(|s| !exec::is_readonly(s))
        {
            return Err(AppError::msg(
                "connection is read-only — write statements are blocked",
            ));
        }
        if let Some(parameters) = options.parameters {
            crate::db::parameters::validate_values(
                parameters,
                crate::db::parameters::driver_of(pool),
            )?;
        }
        if let Some(batch) = &options.batch {
            crate::db::parameter_batch::validate(
                &statements[0],
                batch.sets,
                crate::db::parameters::driver_of(pool),
            )?;
        }
        let session = self.get_or_create(id, session_id, generation)?;
        let mut slot = tokio::select! {
            _ = session.cancel.cancelled() => return Err(AppError::msg("editor session closed")),
            slot = session.slot.lock() => slot,
        };
        if session.cancel.is_cancelled() {
            return Err(AppError::msg("editor session closed"));
        }
        let mut connection = match slot.connection.take() {
            Some(c) => c,
            None if slot.initialized => {
                return Err(AppError::msg(
                    "editor session lost or cancelled; reset the session before running again",
                ))
            }
            None => {
                slot.initialized = true;
                tokio::select! {
                    _ = session.cancel.cancelled() => return Err(AppError::msg("editor session closed")),
                    c = EditorConnection::acquire(pool) => c?,
                }
            }
        };
        // Keep an anchor while tabs open/close: detaching the last SQLite
        // connection must not destroy a shared in-memory database.
        if let DbPool::Sqlite(p) = pool {
            self.ensure_sqlite_anchor(id, generation, &session, p)
                .await?;
        }
        let query_interrupt = QueryInterrupt(CancellationToken::new());
        if let EditorConnection::Sqlite(sqlite) = &mut connection {
            let query_cancel = query_interrupt.0.clone();
            let session_cancel = session.cancel.clone();
            let mut handle = sqlite.lock_handle().await?;
            handle.set_progress_handler(2000, move || {
                !query_cancel.is_cancelled() && !session_cancel.is_cancelled()
            });
        }
        let mut in_transaction = slot.in_transaction;
        let mut manual_commit_mode = slot.manual_commit_mode;
        // The connection is held by this future, not left in the registry. An
        // aborted query drops it instead of keeping a potentially dirty session.
        let result = tokio::select! {
            _ = session.cancel.cancelled() => Err(AppError::msg("editor session closed")),
            r = async {
                if options.readonly {
                    let guard = match connection {
                        EditorConnection::Sqlite(_) => "PRAGMA query_only = ON",
                        EditorConnection::Postgres(_) => "BEGIN READ ONLY",
                        EditorConnection::Mysql(_) => "START TRANSACTION READ ONLY",
                    };
                    one(&mut connection, guard).await?;
                }
                let atomic = options.atomic && !options.readonly && !in_transaction && !manual_commit_mode;
                let result = if let Some(batch) = options.batch {
                    crate::db::parameter_batch::run(&mut connection, &statements[0], atomic,
                        &mut in_transaction, &mut manual_commit_mode, options.readonly, batch).await
                } else if options.source {
                    run_source(&mut connection, &statements[0], &mut in_transaction, &mut manual_commit_mode,
                        SourceExecution { atomic, parameters: options.parameters.unwrap_or(&[]), readonly: options.readonly, preflight: None }).await
                } else {
                    run(&mut connection, statements, atomic, &mut in_transaction, &mut manual_commit_mode,
                        StatementExecution { parameters: options.parameters, readonly: options.readonly, syntax: None }).await
                };
                if options.readonly {
                    let cleanup = if matches!(connection, EditorConnection::Sqlite(_)) { "PRAGMA query_only = OFF" } else { "ROLLBACK" };
                    one(&mut connection, cleanup).await?;
                }
                result
            } => r,
        };
        let healthy = if matches!(&result, Err(_) | Ok(ScriptOutcome::Failed { .. })) {
            tokio::select! {
                _ = session.cancel.cancelled() => false,
                check = tokio::time::timeout(std::time::Duration::from_secs(2), connection.ping()) => check.unwrap_or(false),
            }
        } else {
            true
        };
        if !session.cancel.is_cancelled() && healthy {
            if let EditorConnection::Sqlite(sqlite) = &mut connection {
                sqlite.lock_handle().await?.remove_progress_handler();
            }
            slot.connection = Some(connection);
        }
        slot.in_transaction = in_transaction;
        slot.manual_commit_mode = manual_commit_mode;
        result
    }

    pub async fn status(&self, session_id: &str) -> SessionStatus {
        let session = {
            let registry = self.registry.lock();
            registry
                .sessions
                .get(session_id)
                .or_else(|| registry.plan_sessions.get(session_id))
                .cloned()
        };
        match session {
            Some(s) => {
                let slot = s.slot.lock().await;
                SessionStatus {
                    connected: slot.connection.is_some() && !s.cancel.is_cancelled(),
                    in_transaction: slot.in_transaction,
                    needs_reset: slot.initialized && slot.connection.is_none(),
                }
            }
            None => SessionStatus {
                connected: false,
                in_transaction: false,
                needs_reset: false,
            },
        }
    }

    pub async fn close(&self, session_id: &str) {
        let session = {
            let mut registry = self.registry.lock();
            if let Some(plan) = registry.plan_sessions.remove(session_id) {
                plan.cancel.cancel();
                return;
            }
            registry.sessions.remove(session_id)
        };
        if let Some(s) = session {
            s.cancel.cancel();
            if let Some(connection) = s.slot.lock().await.connection.take() {
                connection.close().await;
            }
        }
    }

    pub async fn close_connection(&self, id: &str) {
        let ids: Vec<String> = {
            let mut registry = self.registry.lock();
            registry.closed_connections.insert(id.to_owned());
            let generation = registry.generations.entry(id.to_owned()).or_insert(0);
            *generation = generation.wrapping_add(1).max(1);
            registry
                .sessions
                .iter()
                .chain(registry.plan_sessions.iter())
                .filter(|(_, s)| s.connection_id == id)
                .map(|(k, session)| {
                    session.cancel.cancel();
                    k.clone()
                })
                .collect()
        };
        for session_id in ids {
            self.close(&session_id).await;
        }
        let anchor = self.sqlite_anchors.lock().remove(id);
        if let Some(anchor) = anchor {
            let _ = anchor.close().await;
        }
    }
}

fn update_transaction(in_transaction: &mut bool, sql: &str) {
    match exec::first_keyword(sql).as_str() {
        "BEGIN" | "START" | "SAVEPOINT" => *in_transaction = true,
        "COMMIT" | "END" => *in_transaction = false,
        "ROLLBACK" if !rollback_to_savepoint(sql) => *in_transaction = false,
        _ => {}
    }
}

fn rollback_to_savepoint(sql: &str) -> bool {
    let words = leading_sql_words(sql, 4);
    words.get(1).is_some_and(|word| word == "TO")
        || (words
            .get(1)
            .is_some_and(|word| matches!(word.as_str(), "WORK" | "TRANSACTION"))
            && words.get(2).is_some_and(|word| word == "TO"))
}

fn leading_sql_words(sql: &str, limit: usize) -> Vec<String> {
    let mut chars = sql.chars().peekable();
    let mut words = Vec::new();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        if c == '-' && chars.peek() == Some(&'-') {
            chars.next();
            for c in chars.by_ref() {
                if c == '\n' {
                    break;
                }
            }
            continue;
        }
        if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut previous = ' ';
            for c in chars.by_ref() {
                if previous == '*' && c == '/' {
                    break;
                }
                previous = c;
            }
            continue;
        }
        if matches!(c, '\'' | '"' | '`') {
            while let Some(next) = chars.next() {
                if next == c {
                    if chars.peek() == Some(&c) {
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
            continue;
        }
        if c == ';' {
            break;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let mut word = c.to_ascii_uppercase().to_string();
            while chars
                .peek()
                .is_some_and(|next| next.is_ascii_alphanumeric() || *next == '_')
            {
                word.push(chars.next().unwrap().to_ascii_uppercase());
            }
            words.push(word);
            if words.len() == limit {
                break;
            }
        }
    }
    words
}

macro_rules! query_connection {
    ($conn:expr, $sql:expr, $decode:ident, $protocol:ident, $returns_rows:expr) => {{
        let start = Instant::now();
        if $returns_rows {
            let (rows, truncated) = exec::fetch_capped(fetch!($protocol, $conn, $sql)).await?;
            let mut result = exec::$decode(rows, start);
            result.truncated = truncated;
            if result.columns.is_empty() {
                result.columns = exec::describe_columns(&mut *$conn, $sql).await;
            }
            Ok::<QueryResult, AppError>(result)
        } else {
            let affected = execute!($protocol, $conn, $sql).await?.rows_affected();
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: Some(affected),
                elapsed_ms: start.elapsed().as_millis() as u64,
                truncated: false,
            })
        }
    }};
}
macro_rules! fetch {
    (prepared, $conn:expr, $sql:expr) => {
        sqlx::query($sql).fetch(&mut *$conn)
    };
    (text, $conn:expr, $sql:expr) => {
        sqlx::Executor::fetch(&mut *$conn, $sql)
    };
}
macro_rules! execute {
    (prepared, $conn:expr, $sql:expr) => {
        sqlx::query($sql).execute(&mut *$conn)
    };
    (text, $conn:expr, $sql:expr) => {
        sqlx::Executor::execute(&mut *$conn, $sql)
    };
}

pub(crate) async fn one(connection: &mut EditorConnection, sql: &str) -> AppResult<QueryResult> {
    one_classified(connection, sql, exec::returns_rows(sql)).await
}

pub(crate) async fn one_classified(
    connection: &mut EditorConnection,
    sql: &str,
    returns_rows: bool,
) -> AppResult<QueryResult> {
    match connection {
        EditorConnection::Sqlite(c) => {
            query_connection!(c, sql, decode_sqlite, prepared, returns_rows)
        }
        EditorConnection::Postgres(c) => {
            query_connection!(c, sql, decode_postgres, prepared, returns_rows)
        }
        EditorConnection::Mysql(c) => query_connection!(c, sql, decode_mysql, text, returns_rows),
    }
}

struct StatementExecution<'a> {
    parameters: Option<&'a [QueryParameter]>,
    readonly: bool,
    syntax: Option<crate::db::parameters::Syntax>,
}

async fn run(
    connection: &mut EditorConnection,
    statements: &[String],
    atomic: bool,
    in_transaction: &mut bool,
    manual_commit_mode: &mut bool,
    options: StatementExecution<'_>,
) -> AppResult<ScriptOutcome> {
    let StatementExecution {
        parameters,
        readonly,
        syntax,
    } = options;
    let start = Instant::now();
    let initial_syntax = if let Some(parameters) = parameters {
        let syntax = match syntax {
            Some(syntax) => syntax,
            None => {
                crate::db::parameters::inspect_statement_syntax(connection, &statements[0]).await?
            }
        };
        crate::db::parameters::validate_bindings(statements, syntax, parameters)?;
        Some(syntax)
    } else {
        None
    };
    let wrapped = atomic && statements.len() > 1;
    if wrapped {
        one(connection, "BEGIN").await?;
    }
    let mut results = Vec::new();
    let mut total_affected = 0;
    let mut budget = crate::db::limits::ResultBudget::default();
    for (index, sql) in statements.iter().enumerate() {
        // Any preceding statement can change the mode, including CALL and rollback.
        let syntax = match (index, initial_syntax) {
            (0, Some(syntax)) => Ok(syntax),
            _ => crate::db::parameters::inspect_statement_syntax(connection, sql).await,
        };
        let executed = match parameters {
            Some(parameters) => match &syntax {
                Ok(syntax) => {
                    crate::db::parameters::execute_on(
                        connection, sql, parameters, readonly, *syntax,
                    )
                    .await
                }
                Err(error) => Err(AppError::msg(error.to_string())),
            },
            None => match &syntax {
                Ok(syntax) => {
                    async {
                        if readonly && matches!(connection, EditorConnection::Mysql(_)) {
                            crate::db::sql_script::check_mysql_readonly(sql, *syntax)?;
                        }
                        let effective = crate::db::sql_script::mysql_effective_sql(sql, *syntax)?;
                        one_classified(connection, sql, exec::returns_rows(&effective)).await
                    }
                    .await
                }
                Err(error) => Err(AppError::msg(error.to_string())),
            },
        };
        match executed {
            Ok(mut result) => {
                let effective = crate::db::sql_script::mysql_effective_sql(sql, syntax?)?;
                let sql = effective.as_ref();
                budget.retain(&mut result);
                total_affected += result.rows_affected.unwrap_or(0);
                if !wrapped {
                    let previous_transaction = *in_transaction;
                    update_transaction(in_transaction, sql);
                    if matches!(connection, EditorConnection::Mysql(_)) {
                        let keyword = exec::first_keyword(sql);
                        let words = leading_sql_words(sql, 3);
                        let temporary = words.get(1).is_some_and(|word| word == "TEMPORARY");
                        if matches!(
                            keyword.as_str(),
                            "ALTER"
                                | "RENAME"
                                | "TRUNCATE"
                                | "GRANT"
                                | "REVOKE"
                                | "ANALYZE"
                                | "OPTIMIZE"
                                | "REPAIR"
                                | "LOCK"
                        ) || (matches!(keyword.as_str(), "CREATE" | "DROP") && !temporary)
                        {
                            *in_transaction = false;
                        }
                        if keyword == "SAVEPOINT" && !previous_transaction && !*manual_commit_mode {
                            *in_transaction = false;
                        }
                        if *manual_commit_mode
                            && !matches!(keyword.as_str(), "COMMIT" | "END" | "ROLLBACK" | "SET")
                        {
                            *in_transaction = true;
                        }
                    }
                }
                if matches!(connection, EditorConnection::Mysql(_))
                    && exec::first_keyword(sql) == "SET"
                {
                    let mode = one(connection, "SELECT @@SESSION.autocommit").await?;
                    let value = mode.rows.first().and_then(|row| row.first());
                    *manual_commit_mode = value.is_some_and(|value| {
                        value == &serde_json::json!(0)
                            || value == &serde_json::json!(false)
                            || value == &serde_json::json!("0")
                    });
                    if !*manual_commit_mode
                        && exec::scan_bare_words(sql, |word| word == "AUTOCOMMIT")
                    {
                        *in_transaction = false;
                    }
                }
                results.push(result);
            }
            Err(error) => {
                let rollback = if wrapped {
                    let _ = one(connection, "ROLLBACK").await;
                    if matches!(connection, EditorConnection::Mysql(_)) {
                        exec::mysql_rollback_state(&statements[..=index])
                    } else {
                        RollbackState::Complete
                    }
                } else {
                    RollbackState::SelfManaged
                };
                return Ok(ScriptOutcome::Failed {
                    failed_index: index,
                    statements: statements.len(),
                    error: error.to_string(),
                    rollback,
                });
            }
        }
    }
    if wrapped {
        one(connection, "COMMIT").await?;
    }
    if let EditorConnection::Sqlite(sqlite) = connection {
        let mut handle = sqlite.lock_handle().await?;
        // SAFETY: SQLx's locked handle keeps the connection alive and excludes
        // worker access for this synchronous SQLite state query.
        *in_transaction =
            unsafe { libsqlite3_sys::sqlite3_get_autocommit(handle.as_raw_handle().as_ptr()) == 0 };
    }
    let mut result = results.last().expect("validated nonempty script").clone();
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(ScriptOutcome::Ok {
        result,
        results,
        total_affected,
        statements: statements.len(),
    })
}

pub(crate) struct SourceExecution<'a> {
    pub atomic: bool,
    pub parameters: &'a [QueryParameter],
    pub readonly: bool,
    // Batch preflight already covered the source, bindings and all future modes.
    pub preflight: Option<&'a crate::db::sql_script::Analysis>,
}

pub(crate) async fn run_source(
    connection: &mut EditorConnection,
    source: &str,
    in_transaction: &mut bool,
    manual_commit_mode: &mut bool,
    execution: SourceExecution<'_>,
) -> AppResult<ScriptOutcome> {
    use crate::db::{parameters as binding, sql_script};
    let SourceExecution {
        atomic,
        parameters,
        readonly,
        preflight,
    } = execution;
    let start = Instant::now();
    let initial = binding::inspect_statement_syntax(connection, source).await?;
    let checked;
    let analysis = if let Some(analysis) = preflight {
        analysis
    } else {
        checked = sql_script::analyze(source, initial, Some(parameters))?;
        &checked
    };
    let wrapped = atomic && analysis.max_statements > 1 && !analysis.manages_transaction;
    if wrapped {
        one(connection, "BEGIN").await?;
    }
    let mut cursor = sql_script::Cursor::default();
    let mut results = Vec::new();
    let mut executed = Vec::<String>::new();
    let mut total_affected = 0;
    let mut budget = crate::db::limits::ResultBudget::default();
    loop {
        let next: AppResult<_> = async {
            let syntax = if executed.is_empty() {
                initial
            } else {
                binding::inspect_statement_syntax(connection, &source[cursor.offset..]).await?
            };
            Ok((cursor.next(source, syntax)?, syntax))
        }
        .await;
        let (statement, syntax) = match next {
            Ok((None, _)) => break,
            Ok((Some(statement), syntax)) => (statement, syntax),
            Err(error) => {
                let rollback =
                    rollback_source(connection, wrapped, &executed, in_transaction).await;
                return Ok(ScriptOutcome::Failed {
                    failed_index: executed.len(),
                    statements: executed.len() + 1,
                    error: error.to_string(),
                    rollback,
                });
            }
        };
        let sql = source[statement.range].to_owned();
        executed.push(sql.clone());
        let outcome = if executed.len() > sql_script::MAX_STATEMENTS {
            Err(AppError::msg("scripts may contain at most 128 statements"))
        } else {
            // Reuse transaction-state tracking and per-statement native binding;
            // the outer loop owns the whole script's atomicity and result budget.
            run(
                connection,
                &[sql],
                false,
                in_transaction,
                manual_commit_mode,
                StatementExecution {
                    parameters: Some(parameters),
                    readonly,
                    syntax: Some(syntax),
                },
            )
            .await
        };
        match outcome {
            Ok(ScriptOutcome::Ok {
                mut result,
                total_affected: affected,
                ..
            }) => {
                budget.retain(&mut result);
                results.push(result);
                total_affected += affected;
            }
            failed => {
                let error = match failed {
                    Ok(ScriptOutcome::Failed { error, .. }) => error,
                    Err(error) => error.to_string(),
                    _ => unreachable!(),
                };
                let rollback =
                    rollback_source(connection, wrapped, &executed, in_transaction).await;
                return Ok(ScriptOutcome::Failed {
                    failed_index: executed.len() - 1,
                    statements: executed.len(),
                    error,
                    rollback,
                });
            }
        }
    }
    if wrapped {
        one(connection, "COMMIT").await?;
        *in_transaction = false;
    }
    let mut result = results.last().cloned().unwrap_or(QueryResult {
        columns: vec![],
        rows: vec![],
        rows_affected: None,
        elapsed_ms: 0,
        truncated: false,
    });
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(ScriptOutcome::Ok {
        result,
        results,
        statements: executed.len(),
        total_affected,
    })
}

async fn rollback_source(
    connection: &mut EditorConnection,
    wrapped: bool,
    executed: &[String],
    in_transaction: &mut bool,
) -> RollbackState {
    if !wrapped {
        return RollbackState::SelfManaged;
    }
    if one(connection, "ROLLBACK").await.is_err() {
        return RollbackState::Partial;
    }
    *in_transaction = false;
    if matches!(connection, EditorConnection::Mysql(_)) {
        exec::mysql_rollback_state(executed)
    } else {
        RollbackState::Complete
    }
}
