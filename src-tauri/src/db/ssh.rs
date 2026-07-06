//! SSH tunneling via the system `ssh` binary.
//!
//! Rather than embed an SSH stack, we shell out to OpenSSH (present on macOS,
//! Linux, and modern Windows) and set up a local port-forward
//! (`ssh -N -L 127.0.0.1:<local>:<dbhost>:<dbport> user@sshhost`). The DB pool
//! then connects to the local endpoint. The child process is owned by the
//! returned `Tunnel`; dropping it (on disconnect) kills the forward.
//!
//! Auth:
//! - key:      `-i <key_path>`; an optional passphrase is fed via SSH_ASKPASS.
//! - password: fed via SSH_ASKPASS (a tiny temp script that echoes $RDB_SSH_PW).
//! - neither:  relies on ssh-agent / ~/.ssh/config (agent or default key).
//!
//! Password/passphrase via SSH_ASKPASS is a Unix path; on Windows only key/agent
//! auth is supported.

use crate::error::{AppError, AppResult};
use crate::model::SshConfig;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub struct Tunnel {
    child: Mutex<Option<Child>>,
    cleanup: Vec<PathBuf>,
    pub local_host: String,
    pub local_port: u16,
}

impl Tunnel {
    fn shutdown(&self) {
        if let Some(mut c) = self.child.lock().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        for p in &self.cleanup {
            let _ = std::fs::remove_file(p);
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Temp files created while setting up a tunnel. Owns cleanup until the
/// `Tunnel` takes over; if `open()` errors out before the tunnel exists
/// (e.g. `ssh` fails to spawn), dropping this removes the files instead of
/// leaking them into the OS temp dir on every failed attempt.
struct TempFiles(Vec<PathBuf>);

impl TempFiles {
    fn take(mut self) -> Vec<PathBuf> {
        std::mem::take(&mut self.0)
    }
}

impl Drop for TempFiles {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Pick a free loopback port by binding to :0 and immediately releasing it.
/// There's a small race before `ssh` rebinds it, but it's tolerable for a
/// desktop app establishing one tunnel at a time.
fn free_local_port() -> AppResult<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::msg(format!("could not reserve local port: {e}")))?;
    Ok(listener
        .local_addr()
        .map_err(|e| AppError::msg(e.to_string()))?
        .port())
}

/// Open an SSH tunnel forwarding a fresh local port to `db_host:db_port` as
/// seen from the SSH server. `secret` is the SSH password or key passphrase.
pub async fn open(
    ssh: &SshConfig,
    db_host: &str,
    db_port: u16,
    secret: Option<&str>,
) -> AppResult<Tunnel> {
    if ssh.host.trim().is_empty() {
        return Err(AppError::msg("SSH host is required"));
    }
    if ssh.username.trim().is_empty() {
        return Err(AppError::msg("SSH username is required"));
    }
    let local_port = free_local_port()?;
    let local_host = "127.0.0.1".to_string();

    let mut cmd = Command::new("ssh");
    cmd.arg("-N") // no remote command, just forward
        .arg("-T") // no pseudo-tty
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("NumberOfPasswordPrompts=1")
        .arg("-L")
        .arg(format!("{local_host}:{local_port}:{db_host}:{db_port}"))
        .arg("-p")
        .arg(ssh.port.to_string());

    let auth = ssh.auth.as_deref().unwrap_or("");
    if auth == "key" {
        if let Some(kp) = ssh.key_path.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("-i").arg(kp);
            cmd.arg("-o").arg("IdentitiesOnly=yes");
        }
    }

    cmd.arg(format!("{}@{}", ssh.username, ssh.host));

    // Temp files we must clean up (askpass script + captured stderr).
    let mut cleanup = TempFiles(Vec::new());

    // Feed password / passphrase non-interactively via SSH_ASKPASS.
    let needs_secret = (auth == "password") || (auth == "key" && secret.is_some());
    if needs_secret {
        let pw = secret.unwrap_or("");
        let script = write_askpass_script(local_port)?;
        cmd.env("RDB_SSH_PW", pw)
            .env("SSH_ASKPASS", &script)
            .env("SSH_ASKPASS_REQUIRE", "force")
            // Some OpenSSH builds still check DISPLAY before using askpass.
            .env("DISPLAY", "rdbstudio:0");
        if auth == "password" {
            cmd.arg("-o").arg("PreferredAuthentications=password,keyboard-interactive");
        }
        cleanup.0.push(script);
    }

    // Capture stderr to a temp file so we can surface ssh's error on failure.
    let err_path = std::env::temp_dir().join(format!("rdb-ssh-{}.log", local_port));
    let err_file = std::fs::File::create(&err_path)
        .map_err(|e| AppError::msg(format!("ssh stderr temp: {e}")))?;
    cleanup.0.push(err_path.clone());

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(err_file));

    let child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("failed to launch ssh: {e}")))?;

    let tunnel = Tunnel {
        child: Mutex::new(Some(child)),
        cleanup: cleanup.take(),
        local_host: local_host.clone(),
        local_port,
    };

    // Wait until the forwarded port accepts connections, or ssh exits early.
    let deadline = Duration::from_secs(15);
    let start = std::time::Instant::now();
    loop {
        // ssh exited before the forward came up → report its stderr.
        if let Some(mut guard) = tunnel.child.try_lock() {
            if let Some(child) = guard.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    drop(guard);
                    let detail = std::fs::read_to_string(&err_path).unwrap_or_default();
                    let detail = detail.trim();
                    return Err(AppError::msg(format!(
                        "SSH tunnel failed ({status}){}{}",
                        if detail.is_empty() { "" } else { ": " },
                        detail
                    )));
                }
            }
        }

        if let Ok(Ok(_stream)) = tokio::time::timeout(
            Duration::from_millis(800),
            tokio::net::TcpStream::connect((local_host.as_str(), local_port)),
        )
        .await
        {
            return Ok(tunnel);
        }

        if start.elapsed() > deadline {
            let detail = std::fs::read_to_string(&err_path).unwrap_or_default();
            let detail = detail.trim();
            return Err(AppError::msg(format!(
                "SSH tunnel timed out after 15s{}{}",
                if detail.is_empty() { "" } else { ": " },
                detail
            )));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Write an executable askpass helper that echoes $RDB_SSH_PW. The password
/// itself is passed via the environment, not written into the script file.
fn write_askpass_script(local_port: u16) -> AppResult<PathBuf> {
    use std::io::Write;
    let dir = std::env::temp_dir();
    // pid alone is constant for the whole app, so concurrent tunnels would
    // share one path and one Drop-time `remove_file` target — tearing down one
    // tunnel could delete the script another is still authenticating against.
    // `local_port` is reserved fresh per tunnel, making the name unique.
    let name = format!("rdb-askpass-{}-{}.sh", std::process::id(), local_port);
    let path = dir.join(name);
    let mut f = std::fs::File::create(&path)
        .map_err(|e| AppError::msg(format!("askpass temp: {e}")))?;
    f.write_all(b"#!/bin/sh\nprintf '%s\\n' \"$RDB_SSH_PW\"\n")
        .map_err(|e| AppError::msg(e.to_string()))?;
    drop(f);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| AppError::msg(e.to_string()))?;
    }
    Ok(path)
}
