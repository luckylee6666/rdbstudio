/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only web bridge endpoint, e.g. http://127.0.0.1:1430 (docs/web-bridge.md). */
  readonly VITE_RDB_BRIDGE_URL?: string;
  readonly VITE_RDB_BRIDGE_TOKEN?: string;
}
