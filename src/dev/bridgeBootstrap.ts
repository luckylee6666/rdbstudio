// Imported first by main.tsx so the shim is in place before any store issues
// its first invoke(). Dead code outside `vite dev`.
import { installWebBridge } from "./webBridge";

const bridgeUrl = import.meta.env.VITE_RDB_BRIDGE_URL;
if (import.meta.env.DEV && bridgeUrl) {
  installWebBridge(bridgeUrl, import.meta.env.VITE_RDB_BRIDGE_TOKEN ?? "");
}
