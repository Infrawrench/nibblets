import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8420", ws: true, changeOrigin: true },
      // Central mode (`dev:central`) talks to Nibblets Connect under `wrangler dev`.
      "/v1": { target: "http://localhost:8787", changeOrigin: true },
      "/.well-known": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
