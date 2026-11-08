import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { lensApi } from "./server/api";

const engineSrc = fileURLToPath(new URL("../../packages/engine/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react(), lensApi()],
  resolve: { alias: { "@lens/engine": engineSrc } },
  server: { port: 5178, strictPort: false },
  preview: { port: 5179 },
  build: { rollupOptions: { input: { main: fileURLToPath(new URL("index.html", import.meta.url)), parity: fileURLToPath(new URL("parity.html", import.meta.url)) } } },
});
