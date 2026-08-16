import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: "127.0.0.1",
    proxy: {
      // 浏览器模式下绕过 opencode.ai 的 CORS 限制（同源代理转发）。
      "/go-gateway": {
        target: "https://opencode.ai",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/go-gateway/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
