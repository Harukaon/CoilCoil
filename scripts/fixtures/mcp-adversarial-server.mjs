import { existsSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "coilcoil-adversarial", version: "1.0.0" });
for (const name of ["snapshot", "type", "navigate", "reload", "screenshot"]) {
  server.registerTool(name, { inputSchema: {} }, async () => ({ content: [{ type: "text", text: name }] }));
}
server.registerTool("wait", { inputSchema: { readyPath: z.string(), releasePath: z.string() } }, async ({ readyPath, releasePath }) => {
  writeFileSync(readyPath, "ready");
  const deadline = Date.now() + 10_000;
  while (!existsSync(releasePath)) {
    if (Date.now() > deadline) throw new Error("Test barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { content: [{ type: "text", text: "completed" }] };
});
await server.connect(new StdioServerTransport());
