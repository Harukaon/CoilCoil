import { app } from "electron";
import type { McpConnectionTest, McpConnectionTestInput } from "../shared/desktop-api";

const TIMEOUT_MS = 15_000;
/** Enough of the reply to carry a server's own error text, not enough to fill the panel. */
const BODY_LIMIT = 400;

/**
 * Ask an HTTP MCP server to shake hands, and report exactly what it said.
 *
 * A misconfigured server is otherwise indistinguishable from a broken one: the
 * adapter reports "failed" and the Agent says the MCP has a problem, while the
 * server itself was answering something specific like "Invalid API key". This
 * sends the same initialize request the adapter would and hands the status line
 * and body straight back, so the answer comes from the server rather than from
 * a guess.
 */
export async function testMcpConnection(input: McpConnectionTestInput): Promise<McpConnectionTest> {
  const url = input.url.trim();
  if (!url) return { ok: false, error: "请先填写服务器地址。" };
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, error: "服务器地址不是合法的 URL。" };
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { ok: false, error: "只能测试 http/https 地址。" };
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "CoilCoil", version: app.getVersion() },
    },
  });

  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Streamable HTTP servers answer with either, and refusing one of them
        // is itself a common reason a handshake fails.
        accept: "application/json, text/event-stream",
        ...input.headers,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await response.text()).trim().slice(0, BODY_LIMIT);
    return { ok: true, status: response.status, statusText: response.statusText, body: text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message === "The operation was aborted due to timeout" ? `连接超时（${TIMEOUT_MS / 1000} 秒）。` : message };
  }
}
