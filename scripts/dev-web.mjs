#!/usr/bin/env node
// Dev-only: run the UI in a browser against the real backend.
// Starts the web bridge (cargo example) before Vite, with a fresh per-run token.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const BRIDGE_START_TIMEOUT_MS = 10 * 60_000;
const BRIDGE_POLL_MS = 100;
const PROCESS_GROUP_GRACE_MS = 1_000;

export function parseBridgePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("RDB_BRIDGE_PORT must be an integer from 1 to 65535");
  }
  return port;
}

/** Bind the exact loopback address used by the bridge before starting services. */
export function assertBridgePortAvailable(port, { createServerFn = createServer } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServerFn();
    server.once("error", (error) => {
      reject(new Error(`Bridge port ${port} is unavailable: ${error.message}`));
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

function childOutcome(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function connectToPort(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function waitForBridge(port, child, {
  signal,
  timeoutMs = BRIDGE_START_TIMEOUT_MS,
  pollMs = BRIDGE_POLL_MS,
  isListening = connectToPort,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const exited = childOutcome(child);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Bridge startup cancelled");
    if (await isListening(port)) return;
    const outcome = await Promise.race([
      exited.then((result) => ({ exited: result })),
      delay(pollMs, null, { signal }).then(() => null).catch(() => ({ cancelled: true })),
    ]);
    if (outcome?.cancelled || signal?.aborted) throw new Error("Bridge startup cancelled");
    if (outcome?.exited) {
      const result = outcome.exited;
      if (result.error) throw new Error(`Bridge failed to start: ${result.error.message}`);
      throw new Error(`Bridge exited before it was ready (code ${result.code ?? result.signal})`);
    }
  }
  throw new Error(`Bridge did not start listening on port ${port} within ${timeoutMs} ms`);
}

function groupExists(pid, killProcess) {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function runTaskkill(pid, spawnProcess) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    killer.once("error", resolve);
    killer.once("exit", resolve);
  });
}

/** Terminate only the process tree rooted at a child started by this script. */
export async function terminateChildTree(child, {
  platform = process.platform,
  signal = "SIGTERM",
  killProcess = process.kill,
  spawnProcess = spawn,
  graceMs = PROCESS_GROUP_GRACE_MS,
} = {}) {
  if (child?.pid == null) return;
  if (platform === "win32") {
    // Windows has no POSIX process groups; taskkill scopes /T to this child PID.
    await runTaskkill(child.pid, spawnProcess);
    return;
  }

  try {
    killProcess(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const stillRunning = groupExists(child.pid, killProcess);
  if (stillRunning && graceMs > 0) await delay(graceMs);
  if (stillRunning && groupExists(child.pid, killProcess)) {
    try {
      killProcess(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function startChild(cmd, args, childEnv, cwd, { platform, spawnProcess, baseEnv }) {
  const child = spawnProcess(cmd, args, {
    stdio: "inherit",
    env: { ...baseEnv, ...childEnv },
    cwd,
    detached: platform !== "win32",
    windowsHide: true,
  });
  child.outcome = childOutcome(child);
  return child;
}

export function viteCommand(platform, env = process.env) {
  if (platform !== "win32") return { command: "pnpm", args: ["exec", "vite"] };
  // pnpm sets npm_execpath when running package scripts. Launch its JS entry
  // through Node so Windows never tries to spawn a .cmd file with shell:false.
  if (env.npm_execpath) {
    return { command: process.execPath, args: [env.npm_execpath, "exec", "vite"] };
  }
  // Direct `node scripts/dev-web.mjs` fallback; the command string is fixed.
  return {
    command: env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", "pnpm exec vite"],
  };
}

/**
 * Run bridge first and start Vite only after its port is accepting connections.
 * Injected dependencies keep startup ordering and occupied-port behavior testable.
 */
export async function runDevWeb({
  port,
  token = randomBytes(24).toString("hex"),
  platform = process.platform,
  env = process.env,
  spawnProcess = spawn,
  preflight = assertBridgePortAvailable,
  waitReady = waitForBridge,
  terminate = terminateChildTree,
  handleSignals = true,
} = {}) {
  const children = [];
  const abortController = new AbortController();
  let signalExitCode;
  let resolveSignal;
  const signalPromise = new Promise((resolve) => { resolveSignal = resolve; });
  let stopping;
  const stopChildren = () => {
    if (!stopping) {
      stopping = Promise.all(children.map((child) => terminate(child, { platform })));
    }
    return stopping;
  };
  const onSignal = (signal) => {
    signalExitCode = signal === "SIGINT" ? 130 : 143;
    abortController.abort();
    resolveSignal({ signal });
    void stopChildren();
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  if (handleSignals) {
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
  }

  try {
    const available = await Promise.race([
      preflight(port).then(() => ({ available: true })),
      signalPromise,
    ]);
    if (available.signal) return signalExitCode;

    const bridge = startChild(
      "cargo",
      ["run", "--example", "web_bridge", "--features", "web-bridge"],
      { RDB_BRIDGE_TOKEN: token, RDB_BRIDGE_PORT: String(port) },
      "src-tauri",
      { platform, spawnProcess, baseEnv: env }
    );
    children.push(bridge);

    const ready = await Promise.race([
      waitReady(port, bridge, { signal: abortController.signal }).then(() => ({ ready: true })),
      signalPromise,
    ]);
    if (ready.signal) return signalExitCode;
    if (bridge.exitCode != null || bridge.signalCode != null) {
      throw new Error("Bridge exited before Vite started");
    }

    const viteStart = viteCommand(platform, env);
    const vite = startChild(
      viteStart.command,
      viteStart.args,
      {
        VITE_RDB_BRIDGE_URL: `http://127.0.0.1:${port}`,
        VITE_RDB_BRIDGE_TOKEN: token,
      },
      undefined,
      { platform, spawnProcess, baseEnv: env }
    );
    children.push(vite);

    const result = await Promise.race([
      Promise.race(children.map((child) => child.outcome)),
      signalPromise,
    ]);
    if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
      return signalExitCode ?? (result.signal === "SIGINT" ? 130 : 143);
    }
    if (result.error) throw result.error;
    return result.code ?? 1;
  } finally {
    abortController.abort();
    if (handleSignals) {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    }
    await stopChildren();
  }
}

async function main() {
  try {
    const port = parseBridgePort(process.env.RDB_BRIDGE_PORT ?? "1430");
    const code = await runDevWeb({ port });
    process.exitCode = code;
  } catch (error) {
    // Never print the per-run token; it is only injected into child environments.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
