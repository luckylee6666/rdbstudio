//! Exercises the SSH tunnel machinery (spawn `ssh`, detect early exit, capture
//! stderr, surface a clean error, honor the deadline) without needing a live
//! SSH server. The happy path — a forward that actually carries DB traffic —
//! still requires a real SSH host and is verified manually.

use rdbstudio_lib::db::ssh;
use rdbstudio_lib::model::SshConfig;

fn ssh_available() -> bool {
    std::process::Command::new("ssh")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn cfg(host: &str, port: u16) -> SshConfig {
    SshConfig {
        host: host.into(),
        port,
        username: "nobody".into(),
        auth: Some("key".into()),
        key_path: None,
        password: None,
    }
}

#[tokio::test]
async fn open_rejects_empty_host() {
    let res = ssh::open(&cfg("", 22), "db", 5432, None).await;
    assert!(res.is_err(), "empty SSH host should be rejected");
}

#[tokio::test]
async fn open_rejects_empty_username() {
    let mut c = cfg("127.0.0.1", 22);
    c.username = String::new();
    let res = ssh::open(&c, "db", 5432, None).await;
    assert!(res.is_err(), "empty SSH user should be rejected");
}

#[tokio::test]
async fn open_fails_fast_when_ssh_port_refuses() {
    if !ssh_available() {
        eprintln!("skipping: no `ssh` binary on PATH");
        return;
    }
    // Port 1 has nothing listening → ssh gets "connection refused" and exits
    // immediately. The tunnel helper should notice the early exit and return an
    // error well before its 15s readiness deadline (rather than hanging).
    let start = std::time::Instant::now();
    let res = ssh::open(&cfg("127.0.0.1", 1), "127.0.0.1", 5432, None).await;
    assert!(res.is_err(), "tunnel to a refused port should fail");
    assert!(
        start.elapsed().as_secs() < 14,
        "should fail fast, took {:?}",
        start.elapsed()
    );
}
