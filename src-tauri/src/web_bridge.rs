//! Dev-only web bridge: serves the app's real IPC command table over a
//! loopback HTTP endpoint so the React UI can run in an ordinary browser tab
//! (Playwright, Chrome devtools) against live databases.
//!
//! Commands execute through Tauri's mock runtime with the same handler table
//! and state as the desktop app. Plugin commands (dialog, clipboard, updater,
//! window) are not hosted here; the browser-side shim in
//! `src/dev/webBridge.ts` answers those.
//!
//! Compiled only with the `web-bridge` feature and started through
//! `cargo run --example web_bridge --features web-bridge`; release bundles
//! never contain it. Requests must carry the per-run token and come from an
//! allowed origin, so other local pages cannot drive the backend.

use crate::{command_handler, load_state};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN, VARY,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow};
use tokio::net::TcpListener;

/// Large enough for base64 binary edits (8 MiB raw) plus JSON framing.
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const TOKEN_HEADER: &str = "x-rdb-bridge-token";

type HttpBody = Full<Bytes>;

pub struct BridgeConfig {
    pub port: u16,
    pub token: String,
    pub data_dir: PathBuf,
    /// Exact browser origins allowed to call the bridge, e.g. the Vite dev
    /// server `http://localhost:1420`.
    pub allowed_origins: Vec<String>,
}

struct Bridge {
    webview: WebviewWindow<MockRuntime>,
    token: String,
    allowed_origins: Vec<String>,
    allowed_hosts: Vec<String>,
}

/// Run the bridge until the process is killed.
pub fn serve(config: BridgeConfig) -> Result<(), Box<dyn std::error::Error>> {
    if config.token.len() < 16 {
        return Err("bridge token must be at least 16 characters".into());
    }
    std::fs::create_dir_all(&config.data_dir)?;
    let app = mock_builder()
        .invoke_handler(command_handler())
        .build(mock_context(noop_assets()))?;
    app.manage(load_state(&config.data_dir)?);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build()?;

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let bridge = Arc::new(Bridge {
        webview,
        token: config.token,
        allowed_origins: config.allowed_origins,
        allowed_hosts: vec![
            format!("127.0.0.1:{}", config.port),
            format!("localhost:{}", config.port),
        ],
    });

    tauri::async_runtime::block_on(async move {
        let listener = TcpListener::bind(addr).await?;
        println!("rdbstudio web bridge listening on http://{addr}");
        loop {
            let (stream, _) = listener.accept().await?;
            let bridge = bridge.clone();
            tauri::async_runtime::spawn(async move {
                let service = service_fn(move |request| handle(request, bridge.clone()));
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    })
}

async fn handle(
    request: Request<Incoming>,
    bridge: Arc<Bridge>,
) -> Result<Response<HttpBody>, Infallible> {
    let origin = request
        .headers()
        .get(ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let Some(origin) = origin.filter(|o| bridge.allowed_origins.iter().any(|a| a == o)) else {
        return Ok(text_response(StatusCode::FORBIDDEN, "origin not allowed"));
    };
    // Reject DNS-rebinding style requests that reach the socket under a
    // foreign host name.
    let host_ok = request
        .headers()
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| bridge.allowed_hosts.iter().any(|a| a == h));
    if !host_ok {
        return Ok(text_response(StatusCode::FORBIDDEN, "host not allowed"));
    }

    if request.method() == Method::OPTIONS {
        return Ok(preflight_response(&origin));
    }
    if request.method() != Method::POST || request.uri().path() != "/invoke" {
        return Ok(with_cors(text_response(StatusCode::NOT_FOUND, "not found"), &origin));
    }
    let token_ok = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t == bridge.token);
    if !token_ok {
        return Ok(with_cors(text_response(StatusCode::UNAUTHORIZED, "bad token"), &origin));
    }

    let body = match Limited::new(request.into_body(), MAX_REQUEST_BYTES).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) => {
            let response = text_response(StatusCode::PAYLOAD_TOO_LARGE, &error.to_string());
            return Ok(with_cors(response, &origin));
        }
    };
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(error) => {
            let response = text_response(StatusCode::BAD_REQUEST, &error.to_string());
            return Ok(with_cors(response, &origin));
        }
    };
    let Some(cmd) = payload.get("cmd").and_then(Value::as_str).map(str::to_owned) else {
        return Ok(with_cors(text_response(StatusCode::BAD_REQUEST, "missing cmd"), &origin));
    };
    if cmd.starts_with("plugin:") {
        let response = json_response(json!({
            "ok": false,
            "error": format!("{cmd} is handled by the browser shim, not the bridge"),
        }));
        return Ok(with_cors(response, &origin));
    }
    let args = payload.get("args").cloned().unwrap_or_else(|| json!({}));

    let webview = bridge.webview.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd,
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "http://tauri.localhost".parse().expect("static url"),
                    body: InvokeBody::Json(args),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
            )
        }))
    })
    .await;

    let response = match outcome {
        Ok(Ok(Ok(body))) => match body.deserialize::<Value>() {
            Ok(data) => json!({ "ok": true, "data": data }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        },
        Ok(Ok(Err(error))) => json!({ "ok": false, "error": error }),
        Ok(Err(_)) | Err(_) => json!({ "ok": false, "error": "command panicked in the bridge" }),
    };
    Ok(with_cors(json_response(response), &origin))
}

fn preflight_response(origin: &str) -> Response<HttpBody> {
    let mut response = with_cors(text_response(StatusCode::NO_CONTENT, ""), origin);
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS".parse().expect("static header"));
    headers.insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        format!("content-type, {TOKEN_HEADER}").parse().expect("static header"),
    );
    headers.insert(ACCESS_CONTROL_MAX_AGE, "600".parse().expect("static header"));
    response
}

fn with_cors(mut response: Response<HttpBody>, origin: &str) -> Response<HttpBody> {
    let headers = response.headers_mut();
    headers.insert(
        ACCESS_CONTROL_ALLOW_ORIGIN,
        origin.parse().expect("allowed origin must be a header value"),
    );
    headers.insert(VARY, "Origin".parse().expect("static header"));
    response
}

fn json_response(value: Value) -> Response<HttpBody> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, "application/json".parse().expect("static header"));
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
