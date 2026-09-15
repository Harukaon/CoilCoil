import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

/**
 * A server that starts something and never comes back.
 *
 * This is what the browser MCP does to a long page action: the SDK's timeout
 * fires, a `notifications/cancelled` goes out, and the server carries on
 * regardless — the work keeps running, only the answer is gone. The connection
 * layer has to say that in words the Agent can act on, and a test needs a
 * server that behaves this way to prove it does.
 */
const server = new McpServer({ name: "coilcoil-slow", version: "1.0.0" });

server.registerTool("sleep", {
  description: "Never answer, so the caller has to time out.",
  inputSchema: { ms: z.number().optional() },
}, async ({ ms }) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms ?? 60_000);
  });
  return { content: [{ type: "text", text: "MCP_SLOW_DONE" }] };
});

await server.connect(new StdioServerTransport());
