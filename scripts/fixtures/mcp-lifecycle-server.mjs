import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InitializeRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const [mode, pidFile] = process.argv.slice(2);
const server = new Server({ name: "coilcoil-lifecycle-test", version: "1.0.0" }, {
  capabilities: { tools: {}, resources: {} },
});

if (mode === "hang" || mode === "delayed") {
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    if (pidFile) writeFileSync(pidFile, String(process.pid));
    if (mode === "hang") await new Promise(() => {});
    else await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "coilcoil-lifecycle-test", version: "1.0.0" },
    };
  });
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
  tools: [{ name: request.params?.cursor ? "second" : "first", inputSchema: { type: "object" } }],
  ...(request.params?.cursor && mode !== "cursor-loop" ? {} : { nextCursor: "second-page" }),
}));
server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  if (mode === "drop-resources") process.exit(0);
  return {
    resources: [{ uri: `test:///${request.params?.cursor ? "second" : "first"}`, name: "resource" }],
    ...(request.params?.cursor ? {} : { nextCursor: "second-page" }),
  };
});

await server.connect(new StdioServerTransport());
