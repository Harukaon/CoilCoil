import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import express from "express";
import * as z from "zod/v4";

function listen(app) {
  return new Promise((resolveListen, rejectListen) => {
    const server = app.listen(0, "127.0.0.1", () => resolveListen(server));
    server.on("error", rejectListen);
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

const authApp = express();
authApp.use(express.json());
authApp.use(express.urlencoded({ extended: false }));
const authHttpServer = await listen(authApp);
const authAddress = authHttpServer.address();
if (!authAddress || typeof authAddress === "string") throw new Error("OAuth fixture failed to bind its authorization server.");
const authServerUrl = new URL(`http://127.0.0.1:${authAddress.port}`);

const resourceApp = createMcpExpressApp();
const resourceHttpServer = await listen(resourceApp);
const resourceAddress = resourceHttpServer.address();
if (!resourceAddress || typeof resourceAddress === "string") throw new Error("OAuth fixture failed to bind its MCP resource server.");
const mcpServerUrl = new URL(`http://127.0.0.1:${resourceAddress.port}/mcp`);

const provider = new DemoInMemoryAuthProvider((resource) => resource?.href === mcpServerUrl.href);
const scopesSupported = ["mcp:tools"];
authApp.use(mcpAuthRouter({
  provider,
  issuerUrl: authServerUrl,
  resourceServerUrl: mcpServerUrl,
  scopesSupported,
}));

const oauthMetadata = createOAuthMetadata({ provider, issuerUrl: authServerUrl, scopesSupported });
resourceApp.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl, scopesSupported }));

let authorizedMcpRequests = 0;
resourceApp.get("/status", (_request, response) => {
  response.json({
    authorizedMcpRequests,
    clients: provider.clientsStore.clients.size,
    tokens: provider.tokens.size,
  });
});

const requireOAuth = requireBearerAuth({
  verifier: provider,
  requiredScopes: scopesSupported,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
});

/**
 * 扮演一台「把过期令牌报成 500」的服务器。
 *
 * 真事：2026-09-14 一台 MCP Server 的 OAuth 实现抛的是普通 Error，而 SDK 的
 * 鉴权中间件只按错误类型决定状态码，认不出来的一律包成 500。于是令牌一过期，客户端
 * 收到的是「服务器内部故障」，而不是带 WWW-Authenticate 的 401——那个头才是叫客户端
 * 去重新授权的信号。
 *
 * 要紧的是只在**带了令牌**的时候这么干：不带令牌时那台服务器仍然正确回 401，所以把
 * 本地凭据删掉就又能登录了。照搬这个不对称，测的才是真实情况。
 */
const misreportAuthErrors = process.env.MCP_FIXTURE_MISREPORT_AUTH === "1";
function misreportAs500(request, response, next) {
  const presentedToken = String(request.headers.authorization ?? "").startsWith("Bearer ");
  if (!misreportAuthErrors || !presentedToken) return next();
  const setStatus = response.status.bind(response);
  response.status = (code) => {
    if (code !== 401) return setStatus(code);
    // 500 那条路根本不会设这个头，少了它客户端就更没线索了。
    response.removeHeader("WWW-Authenticate");
    return setStatus(500);
  };
  next();
}

function createServer() {
  const server = new McpServer({ name: "coilcoil-oauth-smoke", version: "1.0.0" });
  server.registerTool("oauth-echo", {
    description: "Return text through an OAuth-protected MCP connection.",
    inputSchema: { text: z.string() },
  }, async ({ text }) => ({
    content: [{ type: "text", text: `MCP_OAUTH_ECHO:${text}` }],
  }));
  return server;
}

resourceApp.post("/mcp", misreportAs500, requireOAuth, async (request, response) => {
  authorizedMcpRequests += 1;
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        id: null,
      });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

resourceApp.get("/mcp", requireOAuth, (_request, response) => {
  response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});
resourceApp.delete("/mcp", requireOAuth, (_request, response) => {
  response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

const shutdown = async () => {
  await Promise.all([close(resourceHttpServer), close(authHttpServer)]);
  process.exit(0);
};

process.on("message", (message) => {
  if (message?.type === "shutdown") void shutdown();
});
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

process.send?.({
  type: "ready",
  authServerUrl: authServerUrl.href,
  mcpServerUrl: mcpServerUrl.href,
  instanceId: randomUUID(),
});
