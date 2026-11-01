import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // The standalone MCP client must run without workspace TypeScript loaders.
  noExternal: [/^@coilcoil\/runtime-server(?:\/|$)/, /^@coilcoil\/runtime-protocol(?:\/|$)/],
});
