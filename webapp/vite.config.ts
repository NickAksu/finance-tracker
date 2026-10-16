import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Mini App: собирается в webapp/dist, оттуда его раздаёт Worker (wrangler assets, SPA-фолбэк).
export default defineConfig({
  root,
  base: "/", // абсолютные пути к ассетам: SPA открывается и по /r/123
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] }, // импорт ../shared
    proxy: {
      // API отдаёт `wrangler dev` (npm run dev)
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
