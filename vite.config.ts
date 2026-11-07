import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Keep the small shared graph stylesheet with the app styles. Vite caches
    // failed dynamic CSS preloads, so retrying a panel could otherwise mount
    // an unstyled graph. Heavy JavaScript remains loaded on demand.
    cssCodeSplit: false,
    // Split heavy panels into their own chunks so first-paint doesn't ship
    // xyflow / dagre / sql-formatter / codemirror as a single 1.3 MB blob.
    rollupOptions: {
      output: {
        // Optional libraries must not absorb shared React/CommonJS runtime:
        // that creates an eager dependency from the shell back to those chunks.
        manualChunks(id) {
          if (id.includes("\0commonjsHelpers.js") || /\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (/\/node_modules\/(@codemirror|@lezer)\//.test(id)) return "codemirror";
          if (/\/node_modules\/(@xyflow\/[^/]+|dagre)\//.test(id)) return "xyflow";
          if (id.includes("/node_modules/sql-formatter/")) return "sql-formatter";
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
}));
