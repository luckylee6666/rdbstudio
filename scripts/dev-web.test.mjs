import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  assertBridgePortAvailable,
  parseBridgePort,
  runDevWeb,
  terminateChildTree,
  viteCommand,
  waitForBridge,
} from "./dev-web.mjs";

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test("rejects invalid bridge ports before launch", () => {
  for (const value of ["0", "65536", "NaN", "1.5"]) {
    assert.throws(() => parseBridgePort(value), /RDB_BRIDGE_PORT/);
  }
  assert.equal(parseBridgePort("1430"), 1430);
});

test("an occupied bridge port fails before spawning cargo or Vite", async () => {
  const spawns = [];
  const occupied = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });

  await assert.rejects(
    runDevWeb({
      port: 1430,
      preflight: () => assertBridgePortAvailable(1430, {
        createServerFn: () => {
          const server = new EventEmitter();
          server.listen = (options) => {
            assert.deepEqual(options, { host: "127.0.0.1", port: 1430, exclusive: true });
            queueMicrotask(() => server.emit("error", occupied));
          };
          return server;
        },
      }),
      spawnProcess: (...args) => {
        spawns.push(args);
        return fakeChild(1000 + spawns.length);
      },
      handleSignals: false,
    }),
    /Bridge port 1430 is unavailable: address already in use/,
  );
  assert.deepEqual(spawns, []);
});

test("starts Vite only after bridge readiness and uses pnpm", async () => {
  const order = [];
  const children = [];
  const spawns = [];
  const spawnProcess = (command, args, options) => {
    order.push(command);
    spawns.push({ command, args, options });
    const child = fakeChild(2000 + children.length);
    children.push(child);
    if (command === "pnpm") {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
    }
    return child;
  };

  const code = await runDevWeb({
    port: 1430,
    token: "test-token-never-logged",
    env: { BASE_ENV: "kept" },
    platform: "linux",
    spawnProcess,
    preflight: async () => { order.push("preflight"); },
    waitReady: async (_port, bridge) => {
      assert.equal(bridge, children[0]);
      order.push("bridge-ready");
    },
    terminate: async () => {},
    handleSignals: false,
  });

  assert.equal(code, 0);
  assert.deepEqual(order, ["preflight", "cargo", "bridge-ready", "pnpm"]);
  assert.deepEqual(spawns.map(({ command }) => command), ["cargo", "pnpm"]);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[1].options.env.BASE_ENV, "kept");
  assert.equal(spawns[1].options.env.VITE_RDB_BRIDGE_TOKEN, "test-token-never-logged");
});

test("does not start Vite when the bridge exits before becoming ready", async () => {
  const spawns = [];
  await assert.rejects(
    runDevWeb({
      port: 1430,
      platform: "linux",
      spawnProcess: (command) => {
        spawns.push(command);
        const child = fakeChild(3000 + spawns.length);
        if (command === "cargo") {
          queueMicrotask(() => {
            child.exitCode = 1;
            child.emit("exit", 1, null);
          });
        }
        return child;
      },
      preflight: async () => {},
      waitReady: (_port, child) => waitForBridge(1430, child, {
        timeoutMs: 500,
        pollMs: 1,
        isListening: async () => false,
      }),
      terminate: async () => {},
      handleSignals: false,
    }),
    /Bridge exited before it was ready/,
  );
  assert.deepEqual(spawns, ["cargo"]);
});

test("a child terminated by a signal returns a nonzero code and cleans both children", async () => {
  const terminated = [];
  let nextPid = 9000;
  const code = await runDevWeb({
    port: 1430,
    platform: "linux",
    preflight: async () => {},
    waitReady: async () => {},
    spawnProcess: (command) => {
      const child = fakeChild(nextPid++);
      if (command === "pnpm") queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return child;
    },
    terminate: async (child) => { terminated.push(child.pid); },
    handleSignals: false,
  });
  assert.equal(code, 143);
  assert.deepEqual(terminated, [9000, 9001]);
});

test("POSIX cleanup signals only the child process group, then forces leftovers", async () => {
  const signals = [];
  const child = fakeChild(4321);
  await terminateChildTree(child, {
    platform: "linux",
    graceMs: 0,
    killProcess: (pid, signal) => { signals.push([pid, signal]); },
  });
  assert.deepEqual(signals, [[-4321, "SIGTERM"], [-4321, 0], [-4321, 0], [-4321, "SIGKILL"]]);
});

test("Windows cleanup uses taskkill tree mode rooted at the owned child", async () => {
  let invocation;
  await terminateChildTree(fakeChild(9876), {
    platform: "win32",
    spawnProcess: (command, args) => {
      invocation = [command, args];
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.deepEqual(invocation, ["taskkill", ["/PID", "9876", "/T", "/F"]]);
});

test("Windows starts pnpm through its JS entry or a fixed cmd fallback", () => {
  assert.deepEqual(viteCommand("win32", { npm_execpath: "C:\\pnpm\\pnpm.cjs" }), {
    command: process.execPath,
    args: ["C:\\pnpm\\pnpm.cjs", "exec", "vite"],
  });
  assert.deepEqual(viteCommand("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "pnpm exec vite"],
  });
});
