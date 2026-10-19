// Dev-only: lets the UI run in a plain browser tab against the real backend.
// App commands are forwarded to the web bridge (src-tauri/src/web_bridge.rs);
// plugin commands that need a native window are answered here. Installed by
// main.tsx only in `vite dev` with VITE_RDB_BRIDGE_URL set, so production
// bundles tree-shake this module away.

type Args = Record<string, unknown> | undefined;
type DialogOptions = {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  directory?: boolean;
};

let nextCallbackId = 1;
let clipboardText = "";

function askPath(kind: "open" | "save", options: DialogOptions | undefined): string | null {
  const label = options?.title ?? (kind === "open" ? "Open file (path)" : "Save as (path)");
  const answer = window.prompt(label, options?.defaultPath ?? "");
  return answer && answer.trim() ? answer.trim() : null;
}

async function pluginCall(cmd: string, args: Args): Promise<unknown> {
  const [plugin, command] = cmd.slice("plugin:".length).split("|");
  const options = (args?.options ?? args) as DialogOptions | undefined;
  switch (plugin) {
    case "dialog":
      if (command === "open") {
        if (options?.directory) return askPath("open", options);
        const path = askPath("open", options);
        return options?.multiple ? (path ? [path] : null) : path;
      }
      if (command === "save") return askPath("save", options);
      if (command === "message") {
        window.alert(String(args?.message ?? ""));
        return null;
      }
      if (command === "ask" || command === "confirm") {
        return window.confirm(String(args?.message ?? ""));
      }
      break;
    case "clipboard-manager":
      if (command === "write_text") {
        clipboardText = String(args?.text ?? "");
        await navigator.clipboard?.writeText(clipboardText).catch(() => undefined);
        return null;
      }
      if (command === "read_text") return clipboardText;
      break;
    case "updater":
      if (command === "check") return null;
      break;
    case "window":
      if (command === "is_maximized" || command === "is_fullscreen") return false;
      return null;
    case "event":
      if (command === "listen") return nextCallbackId++;
      return null;
    case "app":
      if (command === "version") return "dev";
      break;
  }
  throw `${cmd} is not available in the web bridge`;
}

export function installWebBridge(bridgeUrl: string, token: string): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__) return;
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(callback?: (payload: unknown) => void, once = false) {
      const id = nextCallbackId++;
      w[`_${id}`] = (payload: unknown) => {
        if (once) delete w[`_${id}`];
        callback?.(payload);
      };
      return id;
    },
    unregisterCallback(id: number) {
      delete w[`_${id}`];
    },
    convertFileSrc(path: string) {
      return path;
    },
    async invoke(cmd: string, args: Args = {}) {
      if (cmd.startsWith("plugin:")) return pluginCall(cmd, args);
      if (cmd === "restart_application") {
        window.location.reload();
        return null;
      }
      const response = await fetch(`${bridgeUrl}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rdb-bridge-token": token },
        body: JSON.stringify({ cmd, args }),
      });
      if (!response.ok) throw `web bridge HTTP ${response.status}: ${await response.text()}`;
      const payload = (await response.json()) as { ok: boolean; data?: unknown; error?: unknown };
      if (payload.ok) return payload.data;
      throw payload.error;
    },
  };
}
