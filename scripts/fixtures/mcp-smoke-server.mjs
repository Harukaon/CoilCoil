import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "coilcoil-smoke", version: "1.0.0" });

server.registerTool("echo", {
  description: "Return the supplied smoke-test text unchanged.",
  inputSchema: { text: z.string() },
}, async ({ text }) => ({
  content: [{ type: "text", text: `MCP_ECHO:${text}` }],
}));

server.registerResource(
  "smoke-resource",
  "coilcoil://smoke/resource",
  { mimeType: "text/plain", description: "CoilCoil MCP discovery smoke resource." },
  async () => ({
    contents: [{ uri: "coilcoil://smoke/resource", mimeType: "text/plain", text: "COILCOIL_MCP_RESOURCE_OK" }],
  }),
);

await server.connect(new StdioServerTransport());
