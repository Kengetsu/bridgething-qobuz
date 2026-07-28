import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: "settings",
  plugins: [react(), viteSingleFile()],
  build: {
    target: "es2022",
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, "settings", "settings.html"),
    },
  },
});
