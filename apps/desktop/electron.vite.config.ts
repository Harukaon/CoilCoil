import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          // Workspace packages ship TypeScript source, so they must be bundled
          // rather than externalized: an externalized one is resolved at runtime
          // and dies on its own `.js` import specifiers before anything starts.
          "@coilcoil/diagnostics",
          "@coilcoil/mcp",
          "@coilcoil/runtime-core",
          "@coilcoil/runtime-protocol",
          "@coilcoil/runtime-server",
        ],
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          runtime: resolve("src/runtime/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
  },
});
