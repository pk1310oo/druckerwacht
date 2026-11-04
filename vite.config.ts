import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri erwartet einen festen Port
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2021", sourcemap: false },
});
