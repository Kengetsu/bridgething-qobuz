import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: mode === "carthing" ? "chrome69" : "es2022",
    sourcemap: true,
    outDir: "dist",
  },
}));
