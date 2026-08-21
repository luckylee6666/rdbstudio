use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, McpGrant};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, ORIGIN,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const DEFAULT_TTL_MINUTES: u64 = 60;
const MAX_TTL_MINUTES: u64 = 24 * 60;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_QUERY_TEXT_BYTES: usize = 100 * 1024;
const MAX_MCP_ROWS: usize = 500;
const MAX_METADATA_ITEMS: usize = 1_000;
const MAX_QUERY_RESULT_JSON_BYTES: usize = 384 * 1024;
const MAX_TOOL_RESPONSE_BYTES: usize = 512 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_TIMEOUT: Duration = Duration::from_secs(10);
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
const DEFAULT_PROTOCOL_VERSION: &str = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[LATEST_PROTOCOL_VERSION, DEFAULT_PROTOCOL_VERSION];
const MCP_PROTOCOL_VERSION_HEADER: &str = "mcp-protocol-version";

type HttpBody = Full<Bytes>;

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub url: Option<String>,
    pub authorization_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpAuthorization {
    pub server_url: String,
    pub token: String,
    pub connection_id: String,
    pub connection_name: String,
    pub expires_at: String,
    pub config_json: String,
}

#[derive(Debug, Serialize)]
struct LimitedItems<T> {
    items: Vec<T>,
    truncated: bool,
}

#[tauri::command]
pub fn mcp_status(state: State<'_, AppState>) -> McpStatus {
    status_for(&state)
}

#[tauri::command]
pub async fn start_mcp(app: AppHandle, state: State<'_, AppState>) -> AppResult<McpStatus> {
    ensure_server(&app, &state).await?;
    Ok(status_for(&state))
}

#[tauri::command]
pub fn stop_mcp(state: State<'_, AppState>) -> McpStatus {
    state.mcp.stop();
    status_for(&state)
}

#[tauri::command]
pub fn revoke_mcp_authorizations(state: State<'_, AppState>) -> McpStatus {
    state.mcp.revoke_all();
    status_for(&state)
}

#[tauri::command]
pub async fn create_mcp_authorization(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    ttl_minutes: Option<u64>,
) -> AppResult<McpAuthorization> {
    let config = state
        .store
        .get(&id)
        .ok_or_else(|| AppError::msg("connection not found"))?;
    let server_url = ensure_server(&app, &state).await?;
    let ttl = ttl_minutes
        .unwrap_or(DEFAULT_TTL_MINUTES)
        .clamp(1, MAX_TTL_MINUTES);
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let expires = chrono::Utc::now() + chrono::Duration::minutes(ttl as i64);
    let expires_at = expires.to_rfc3339();
    let cancellation = CancellationToken::new();
    let expiration = cancellation.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(ttl * 60)).await;
        expiration.cancel();
    });
    state.mcp.add_grant(
        token.clone(),
        McpGrant {
            connection_id: id.clone(),
            expires_at: Instant::now() + Duration::from_secs(ttl * 60),
            expires_at_text: expires_at.clone(),
            cancellation,
        },
    );
    let config_json = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "rdbstudio": {
                "type": "http",
                "url": server_url,
                "headers": {
                    "Authorization": format!("Bearer {token}")
                }
            }
        }
    }))?;
    Ok(McpAuthorization {
        server_url,
        token,
        connection_id: id,
        connection_name: config.name,
        expires_at,
        config_json,
    })
}

fn status_for(state: &AppState) -> McpStatus {
    let (url, authorization_count) = state.mcp.status();
    McpStatus {
        running: url.is_some(),
        url,
        authorization_count,
    }
}

async fn ensure_server(app: &AppHandle, state: &AppState) -> AppResult<String> {
    let _start = state.mcp.start_lock.lock().await;
    if let (Some(url), _) = state.mcp.status() {
        return Ok(url);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let (stop_tx, stop_rx) = oneshot::channel();
    state.mcp.set_server(url.clone(), stop_tx);
    let app = app.clone();
    let stopped_url = url.clone();
    tauri::async_runtime::spawn(async move {
        serve(listener, app.clone(), stop_rx).await;
        app.state::<AppState>().mcp.mark_stopped(&stopped_url);
    });
    Ok(url)
}

async fn serve(listener: TcpListener, app: AppHandle, mut stop: oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            _ = &mut stop => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                let Ok(connection_slot) = app
                    .state::<AppState>()
                    .mcp
                    .connection_slots
                    .clone()
                    .try_acquire_owned()
                else {
                    // Refuse excess sockets before spawning a task. Together
                    // with the header deadline this bounds slow/incomplete
                    // local clients even if they know a valid token.
                    drop(stream);
                    continue;
                };
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _connection_slot = connection_slot;
                    let service = service_fn(move |request| handle_http(request, app.clone()));
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADER_TIMEOUT)
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        }
    }
}

async fn handle_http(
    request: Request<Incoming>,
    app: AppHandle,
) -> Result<Response<HttpBody>, Infallible> {
    let response = handle_http_inner(request, app)
        .await
        .unwrap_or_else(|error| {
            text_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        });
    Ok(response)
}

async fn handle_http_inner(
    request: Request<Incoming>,
    app: AppHandle,
) -> AppResult<Response<HttpBody>> {
    if request.uri().path() != "/mcp" {
        return Ok(text_response(StatusCode::NOT_FOUND, "not found"));
    }
    let origin = request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if !origin_allowed(origin.as_deref()) {
        return Ok(text_response(
            StatusCode::FORBIDDEN,
            "origin is not allowed",
        ));
    }
    if request.method() == Method::OPTIONS {
        return Ok(cors_response(origin.as_deref()));
    }
    if request.method() != Method::POST {
        return Ok(text_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "only POST is supported",
        ));
    }

    let token = bearer_token(
        request
            .headers()
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
    )
    .map(str::to_owned);
    let grant = token
        .as_deref()
        .and_then(|token| app.state::<AppState>().mcp.grant(token));
    let Some(grant) = grant else {
        return Ok(text_response(
            StatusCode::UNAUTHORIZED,
            "missing or expired authorization",
        ));
    };
    let protocol_header = match request.headers().get(MCP_PROTOCOL_VERSION_HEADER) {
        Some(value) => match value.to_str() {
            Ok(value) => Some(value.to_owned()),
            Err(_) => {
                return Ok(text_response(
                    StatusCode::BAD_REQUEST,
                    "invalid MCP-Protocol-Version header",
                ))
            }
        },
        None => None,
    };

    let body_future = tokio::time::timeout(
        BODY_TIMEOUT,
        Limited::new(request.into_body(), MAX_REQUEST_BYTES).collect(),
    );
    let body = tokio::select! {
        _ = grant.cancellation.cancelled() => {
            return Ok(text_response(
                StatusCode::UNAUTHORIZED,
                "authorization was revoked",
            ));
        }
        result = body_future => match result {
            Err(_) => {
                return Ok(text_response(
                    StatusCode::REQUEST_TIMEOUT,
                    "request body timed out",
                ));
            }
            Ok(Err(_)) => {
                return Ok(text_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request is too large or invalid",
                ));
            }
            Ok(Ok(body)) => body.to_bytes(),
        }
    };

    let state = app.state::<AppState>();
    let _request_slot = match state.mcp.request_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return Ok(text_response(
                StatusCode::TOO_MANY_REQUESTS,
                "too many concurrent MCP requests",
            ))
        }
    };
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(_) => return Ok(rpc_error_response(Value::Null, -32700, "invalid JSON")),
    };
    let id = message.get("id").cloned();
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Ok(rpc_error_response(
            id.unwrap_or(Value::Null),
            -32600,
            "invalid request",
        ));
    };
    if method != "initialize" && !protocol_version_is_supported(protocol_header.as_deref()) {
        return Ok(text_response(
            StatusCode::BAD_REQUEST,
            "unsupported MCP-Protocol-Version",
        ));
    }
    if id.is_none() {
        return Ok(empty_response(StatusCode::ACCEPTED));
    }
    let id = id.unwrap_or(Value::Null);
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => Ok(initialize_result(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => {
            // Re-read the grant after body parsing so an edit/revoke/expiry
            // cannot use the cloned authorization captured at header time.
            let Some(active_grant) = token.as_deref().and_then(|token| state.mcp.grant(token))
            else {
                return Ok(text_response(
                    StatusCode::UNAUTHORIZED,
                    "authorization was revoked or expired",
                ));
            };
            tokio::select! {
                _ = active_grant.cancellation.cancelled() => {
                    Err(AppError::msg("authorization was revoked"))
                }
                result = tokio::time::timeout(
                    QUERY_TIMEOUT,
                    call_tool(&app, &active_grant, params),
                ) => match result {
                    Ok(result) => result,
                    Err(_) => Err(AppError::msg("tool call timed out after 30 seconds")),
                }
            }
        }
        _ => return Ok(rpc_error_response(id, -32601, "method not found")),
    };
    let response = match result {
        Ok(result) => rpc_result_response(id, result),
        Err(error) => rpc_result_response(id, tool_error(&error.to_string())),
    };
    Ok(with_cors(response, origin.as_deref()))
}

fn requested_protocol_version(params: &Value) -> &'static str {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    SUPPORTED_PROTOCOL_VERSIONS
        .iter()
        .copied()
        .find(|version| Some(*version) == requested)
        .unwrap_or(LATEST_PROTOCOL_VERSION)
}

fn protocol_version_is_supported(header: Option<&str>) -> bool {
    // MCP specifies 2025-03-26 as the compatibility default when a client
    // omits the header on a post-initialization HTTP request.
    let version = header.unwrap_or(DEFAULT_PROTOCOL_VERSION).trim();
    SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
}

fn initialize_result(params: &Value) -> Value {
    json!({
        "protocolVersion": requested_protocol_version(params),
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "rdbstudio", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "A local, read-only database bridge. Access is limited to the connection authorized in rdbstudio."
    })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool("connection_info", "Show the authorized connection alias and driver. Never returns credentials or host details.", json!({ "type": "object", "properties": {}, "additionalProperties": false })),
        tool("list_databases", "List databases or top-level namespaces visible on the authorized connection. Returns bounded items plus a truncated flag.", json!({ "type": "object", "properties": {}, "additionalProperties": false })),
        tool("list_schemas", "List schemas. The database argument is optional and driver-dependent. Returns bounded items plus a truncated flag.", json!({ "type": "object", "properties": { "database": { "type": "string" } }, "additionalProperties": false })),
        tool("list_tables", "List tables, views, or Redis keys in a schema/namespace. Returns bounded items plus a truncated flag.", json!({ "type": "object", "properties": { "schema": { "type": "string" } }, "additionalProperties": false })),
        tool("list_columns", "List columns for a SQL table. Returns bounded items plus a truncated flag.", json!({ "type": "object", "properties": { "table": { "type": "string" }, "schema": { "type": "string" } }, "required": ["table"], "additionalProperties": false })),
        tool("describe_table", "Return columns, keys, indexes, relationships, and estimates for a SQL table.", json!({ "type": "object", "properties": { "table": { "type": "string" }, "schema": { "type": "string" } }, "required": ["table"], "additionalProperties": false })),
        tool("show_ddl", "Return the CREATE DDL for a SQL table or view.", json!({ "type": "object", "properties": { "table": { "type": "string" }, "schema": { "type": "string" } }, "required": ["table"], "additionalProperties": false })),
        tool("query", "Execute exactly one read-only SQL statement or one read-only Redis command. Writes are always rejected.", json!({ "type": "object", "properties": { "sql": { "type": "string", "description": "SQL statement or Redis command" } }, "required": ["sql"], "additionalProperties": false })),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

async fn call_tool(app: &AppHandle, grant: &McpGrant, params: Value) -> AppResult<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::msg("tool name is required"))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let state = app.state::<AppState>();
    let config = state
        .store
        .get(&grant.connection_id)
        .ok_or_else(|| AppError::msg("authorized connection no longer exists"))?;

    if name == "connection_info" {
        return tool_success(json!({
            "name": config.name,
            "driver": config.driver,
            "database": config.database,
            "readOnly": true,
            "authorizationExpiresAt": grant.expires_at_text,
        }));
    }

    let pool = ensure_pool(&state, &grant.connection_id).await?;
    let schema = optional_string(&args, "schema");
    let value = match name {
        "list_databases" => serde_json::to_value(limit_metadata_items(
            crate::db::meta::list_databases(&pool).await?,
        ))?,
        "list_schemas" => serde_json::to_value(
            limit_metadata_items(
                crate::db::meta::list_schemas(&pool, optional_string(&args, "database")).await?,
            ),
        )?,
        "list_tables" => serde_json::to_value(limit_metadata_items(
            crate::db::meta::list_tables(&pool, schema).await?,
        ))?,
        "list_columns" => {
            let table = required_string(&args, "table")?;
            serde_json::to_value(limit_metadata_items(
                crate::db::meta::list_columns(&pool, schema, table).await?,
            ))?
        }
        "describe_table" => {
            let table = required_string(&args, "table")?;
            serde_json::to_value(crate::db::design::describe(&pool, schema, table).await?)?
        }
        "show_ddl" => {
            let table = required_string(&args, "table")?;
            serde_json::to_value(crate::db::design::ddl(&pool, schema, table).await?)?
        }
        "query" => {
            let sql = required_string(&args, "sql")?;
            if sql.len() > MAX_QUERY_TEXT_BYTES {
                return Err(AppError::msg("query text is too large"));
            }
            if !mcp_query_is_readonly(matches!(&pool, DbPool::Redis(_)), sql) {
                return Err(AppError::msg(
                    "MCP access is read-only; writes and multiple statements are blocked",
                ));
            }
            let mut result = match &pool {
                DbPool::Redis(_) => crate::db::exec::execute(&pool, sql).await?,
                _ => {
                    crate::db::exec::execute_mcp_readonly(
                        &pool,
                        sql,
                        MAX_MCP_ROWS,
                        MAX_QUERY_RESULT_JSON_BYTES,
                    )
                    .await?
                }
            };
            // Redis replies are produced by its command protocol rather than
            // SQL row streaming. Keep the same external row ceiling; the
            // MCP-specific command allowlist separately blocks DUMP/KEYS and
            // administrative responses that are both sensitive and large.
            if result.rows.len() > MAX_MCP_ROWS {
                result.rows.truncate(MAX_MCP_ROWS);
                result.truncated = true;
            }
            serde_json::to_value(result)?
        }
        _ => return Err(AppError::msg("unknown tool")),
    };
    tool_success(value)
}

async fn ensure_pool(state: &AppState, id: &str) -> AppResult<DbPool> {
    if let Some(pool) = state.get_pool(id) {
        return Ok(pool);
    }
    crate::commands::connections::connect_stored(state, id).await?;
    state
        .get_pool(id)
        .ok_or_else(|| AppError::msg("connection did not become available"))
}

fn mcp_query_is_readonly(redis: bool, input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return false;
    }
    if redis {
        return !trimmed.contains('\n') && crate::db::redis_ops::line_is_mcp_safe(trimmed);
    }
    let statement = trimmed.strip_suffix(';').unwrap_or(trimmed).trim_end();
    !statement.contains(';') && crate::db::exec::is_readonly(statement)
}

fn required_string<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::msg(format!("{key} is required")))
}

fn optional_string<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn limit_metadata_items<T>(mut items: Vec<T>) -> LimitedItems<T> {
    let truncated = items.len() > MAX_METADATA_ITEMS;
    items.truncate(MAX_METADATA_ITEMS);
    LimitedItems { items, truncated }
}

fn tool_success(value: Value) -> AppResult<Value> {
    // Return one representation only. Duplicating the same payload in both
    // text and structuredContent doubles memory and can make the final JSON
    // envelope exceed the checked limit after escaping.
    let text = serde_json::to_string(&value)?;
    if text.len() > MAX_TOOL_RESPONSE_BYTES {
        return Err(AppError::msg(
            "tool response is larger than 512 KiB; narrow the query or add a LIMIT",
        ));
    }
    Ok(json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false,
    }))
}

fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

fn bearer_token(header: Option<&str>) -> Option<&str> {
    header?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    origin == "tauri://localhost"
        || origin == "http://localhost"
        || origin.starts_with("http://localhost:")
        || origin == "http://127.0.0.1"
        || origin.starts_with("http://127.0.0.1:")
}

fn cors_response(origin: Option<&str>) -> Response<HttpBody> {
    let mut response = with_cors(empty_response(StatusCode::NO_CONTENT), origin);
    response.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        "POST, OPTIONS".parse().expect("static header"),
    );
    response.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        "Authorization, Content-Type, MCP-Protocol-Version"
            .parse()
            .expect("static header"),
    );
    response
}

fn with_cors(mut response: Response<HttpBody>, origin: Option<&str>) -> Response<HttpBody> {
    if let Some(origin) = origin {
        response.headers_mut().insert(
            ACCESS_CONTROL_ALLOW_ORIGIN,
            origin
                .parse()
                .expect("validated origin must be a header value"),
        );
    }
    response
}

fn rpc_result_response(id: Value, result: Value) -> Response<HttpBody> {
    json_response(
        StatusCode::OK,
        json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    )
}

fn rpc_error_response(id: Value, code: i64, message: &str) -> Response<HttpBody> {
    json_response(
        StatusCode::OK,
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    )
}

fn json_response(status: StatusCode, value: Value) -> Response<HttpBody> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        "application/json".parse().expect("static header"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().expect("static header"));
    response
}

fn text_response(status: StatusCode, message: &str) -> Response<HttpBody> {
    let mut response = Response::new(Full::new(Bytes::copy_from_slice(message.as_bytes())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        "text/plain; charset=utf-8".parse().expect("static header"),
    );
    response
}

fn empty_response(status: StatusCode) -> Response<HttpBody> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_tokens_require_the_scheme_and_a_value() {
        assert_eq!(bearer_token(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(Some("bearer abc")), None);
        assert_eq!(bearer_token(Some("Bearer   ")), None);
        assert_eq!(bearer_token(None), None);
    }

    #[test]
    fn origins_are_limited_to_local_clients() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://127.0.0.1:1420")));
        assert!(origin_allowed(Some("http://localhost:3000")));
        assert!(origin_allowed(Some("tauri://localhost")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("http://localhost.evil.example")));
    }

    #[test]
    fn tools_are_read_only_and_have_schemas() {
        let tools = tool_definitions();
        assert_eq!(tools.len(), 8);
        assert!(tools.iter().all(|tool| tool.get("inputSchema").is_some()));
        assert!(tools
            .iter()
            .all(|tool| { tool.get("name").and_then(Value::as_str) != Some("execute") }));
    }

    #[test]
    fn protocol_versions_are_negotiated_and_validated() {
        assert_eq!(
            requested_protocol_version(&json!({ "protocolVersion": "2025-03-26" })),
            "2025-03-26"
        );
        assert_eq!(
            requested_protocol_version(&json!({ "protocolVersion": "2099-01-01" })),
            LATEST_PROTOCOL_VERSION
        );
        assert!(protocol_version_is_supported(Some("2025-06-18")));
        assert!(protocol_version_is_supported(Some("2025-03-26")));
        assert!(protocol_version_is_supported(None));
        assert!(!protocol_version_is_supported(Some("2099-01-01")));
        assert!(!protocol_version_is_supported(Some("not-a-version")));
    }

    #[test]
    fn sql_tool_rejects_writes_and_multiple_statements() {
        assert!(mcp_query_is_readonly(false, "SELECT * FROM users;"));
        assert!(mcp_query_is_readonly(
            false,
            "WITH u AS (SELECT 1) SELECT * FROM u"
        ));
        assert!(!mcp_query_is_readonly(
            false,
            "UPDATE users SET admin = true"
        ));
        assert!(!mcp_query_is_readonly(false, "SELECT 1; DELETE FROM users"));
        assert!(!mcp_query_is_readonly(false, ""));
    }

    #[test]
    fn redis_tool_uses_the_read_only_command_allowlist() {
        assert!(mcp_query_is_readonly(true, "GET profile:1"));
        assert!(mcp_query_is_readonly(true, "SCAN 0 COUNT 10"));
        assert!(!mcp_query_is_readonly(true, "CONFIG GET requirepass"));
        assert!(!mcp_query_is_readonly(true, "CLIENT LIST"));
        assert!(!mcp_query_is_readonly(true, "INFO replication"));
        assert!(!mcp_query_is_readonly(true, "KEYS *"));
        assert!(!mcp_query_is_readonly(true, "SET profile:1 value"));
        assert!(!mcp_query_is_readonly(true, "GET a\nDEL a"));
    }

    #[test]
    fn tool_results_are_not_duplicated_in_structured_content() {
        let result = tool_success(json!({ "rows": [[1, "value"]] })).unwrap();
        assert!(result.get("structuredContent").is_none());
        assert_eq!(result.get("isError"), Some(&Value::Bool(false)));
    }

    #[test]
    fn metadata_item_count_is_bounded() {
        let values: Vec<usize> = (0..MAX_METADATA_ITEMS + 10).collect();
        let limited = limit_metadata_items(values);
        assert_eq!(limited.items.len(), MAX_METADATA_ITEMS);
        assert_eq!(limited.items.last(), Some(&(MAX_METADATA_ITEMS - 1)));
        assert!(limited.truncated);
    }
}
