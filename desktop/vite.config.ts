import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // Required so Electron can load `dist/index.html` with relative asset paths.
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
}));
