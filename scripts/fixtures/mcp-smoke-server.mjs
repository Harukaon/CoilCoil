import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "suocode-smoke", version: "1.0.0" });

server.registerTool("echo", {
  description: "Return the supplied smoke-test text unchanged.",
  inputSchema: { text: z.string() },
}, async ({ text }) => ({
  content: [{ type: "text", text: `MCP_ECHO:${text}` }],
}));

server.registerResource(
  "smoke-resource",
  "suocode://smoke/resource",
  { mimeType: "text/plain", description: "SuoCode MCP discovery smoke resource." },
  async () => ({
    contents: [{ uri: "suocode://smoke/resource", mimeType: "text/plain", text: "SUOCODE_MCP_RESOURCE_OK" }],
  }),
);

await server.connect(new StdioServerTransport());
