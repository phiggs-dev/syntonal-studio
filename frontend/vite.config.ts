/** Vite serves local development; FastAPI serves the production dist directory. */
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8675" },
  },
  preview: { host: "127.0.0.1" },
});
