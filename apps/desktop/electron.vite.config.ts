import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@suocode/runtime-core",
          "@suocode/runtime-protocol",
          "@suocode/runtime-server",
        ],
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "browser-debug-mcp": resolve("src/main/browser-debug-mcp.ts"),
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
