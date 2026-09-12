/**
 * 一台只会「一直不返回」的 MCP 服务器。
 *
 * 用来验一件事：界面上的停止按钮，按得停一次正在进行的 MCP 调用吗。没有这样一台
 * 服务器就验不了——真实的工具都会很快回来，而这个 bug 只在「工具还没回来」的那段
 * 时间里看得见。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "coilcoil-stall", version: "1.0.0" });

server.registerTool("stall", {
  description: "Never returns; used to test cancellation.",
  inputSchema: {},
}, async () => {
  await new Promise(() => {});
  return { content: [{ type: "text", text: "unreachable" }] };
});

await server.connect(new StdioServerTransport());
