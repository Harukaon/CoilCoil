import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Builds the standalone preview page; see main.tsx for why it exists. */
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: { outDir: resolve(__dirname, "../../out/ui-preview"), emptyOutDir: true },
});
