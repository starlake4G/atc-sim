import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 监听 0.0.0.0：同一局域网内的手机/另一台机器可以直接访问
  server: { host: "0.0.0.0", port: 5173 },
  preview: { host: "0.0.0.0", port: 4173 },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
