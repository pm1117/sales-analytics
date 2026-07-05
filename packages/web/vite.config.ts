import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開発時は collector API (:3000) へ proxy して CORS を回避する（基本設計 §8: BFF なし）
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/assessments": "http://localhost:3000",
    },
  },
});
