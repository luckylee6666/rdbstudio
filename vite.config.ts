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
    // Split heavy panels into their own chunks so first-paint doesn't ship
    // xyflow / dagre / sql-formatter / codemirror as a single 1.3 MB blob.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          codemirror: [
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/commands",
            "@codemirror/search",
            "@codemirror/language",
            "@codemirror/autocomplete",
            "@codemirror/lang-sql",
            "@lezer/highlight",
          ],
          xyflow: ["@xyflow/react", "dagre"],
          "sql-formatter": ["sql-formatter"],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
}));
