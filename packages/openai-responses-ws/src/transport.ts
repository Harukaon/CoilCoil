import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import type { ApiProvider } from "@earendil-works/pi-ai/compat";
import { OPENAI_RESPONSES_WS_API, OPENAI_RESPONSES_WS_PROVIDER_ID } from "./config.js";

export type OpenAIResponsesWsStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface OpenAIResponsesWsTransport {
  stream: (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream;
  streamSimple: OpenAIResponsesWsStream;
}

function resolvePiCodexTransport(): { path: string; directory: string } {
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/openai-codex-responses")));
  } catch { /* Try physical package paths below. */ }
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
    candidates.push(join(dirname(entry), "api", "openai-codex-responses.js"));
  } catch { /* The error below includes all attempted paths. */ }
  for (const path of candidates) {
    if (existsSync(path)) return { path, directory: dirname(path) };
  }
  throw new Error(`无法定位 Pi 的 openai-codex-responses transport：${candidates.join(", ") || "没有候选路径"}`);
}

function rewriteRelativeImports(source: string, directory: string): string {
  return source.replace(/from\s+"((?:\.\.?\/)[^"]+)"/g, (_match, relativePath: string) =>
    `from ${JSON.stringify(pathToFileURL(join(directory, relativePath)).href)}`);
}

/**
 * Build CoilCoil's extension transport from Pi's Responses event implementation.
 * Unlike Pi's ChatGPT Codex provider, this API provider follows the public OpenAI
 * WebSocket endpoint: `/v1/responses`, ordinary Bearer auth, and `response.create`.
 */
export function adaptPiCodexTransportSource(source: string): string {
  const accountFunction = /function extractAccountId\(token\) \{[\s\S]*?\n\}/;
  if (!accountFunction.test(source)) throw new Error("Pi transport changed: extractAccountId was not found.");
  source = source.replace(accountFunction, `function extractAccountId(_token) {\n\treturn \"\";\n}`);

  const accountHeader = `headers.set("chatgpt-account-id", accountId);`;
  if (!source.includes(accountHeader)) throw new Error("Pi transport changed: account-id header was not found.");
  source = source.replace(accountHeader, `if (accountId) headers.set("chatgpt-account-id", accountId);`);

  const providerSet = /const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/;
  if (!providerSet.test(source)) throw new Error("Pi transport changed: tool-call provider set was not found.");
  source = source.replace(providerSet, (_match, entries: string) =>
    `const CODEX_TOOL_CALL_PROVIDERS = new Set([${entries}, ${JSON.stringify(OPENAI_RESPONSES_WS_PROVIDER_ID)}]);`);

  source = source.replaceAll(`api: "openai-codex-responses"`, `api: ${JSON.stringify(OPENAI_RESPONSES_WS_API)}`);

  const endpointFunction = /function resolveCodexUrl\(baseUrl\) \{[\s\S]*?\n\}/;
  if (!endpointFunction.test(source)) throw new Error("Pi transport changed: resolveCodexUrl was not found.");
  source = source.replace(endpointFunction, `function resolveCodexUrl(baseUrl) {
\tconst raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : "https://api.openai.com/v1";
\tconst url = new URL(raw);
\tlet path = url.pathname.replace(/\\/+$/, "");
\tif (!path || path === "/") path = "/v1";
\tif (!path.endsWith("/responses")) path = \`\${path}/responses\`;
\turl.pathname = path.replace(/\\/{2,}/g, "/");
\turl.search = "";
\turl.hash = "";
\treturn url.toString();
}`);

  const betaHeader = `headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);`;
  if (!source.includes(betaHeader)) throw new Error("Pi transport changed: private WebSocket beta header was not found.");
  source = source.replace(betaHeader, "");

  const disabledFallback = /const websocketDisabledForSession\s*=\s*transport !== "sse" && isWebSocketSseFallbackActive\(cacheSessionId\);/;
  if (!disabledFallback.test(source)) throw new Error("Pi transport changed: WS fallback guard was not found.");
  source = source.replace(disabledFallback, "const websocketDisabledForSession = false;");

  const fallbackBlock = /recordWebSocketFailure\(cacheSessionId, error\);\s*if \(websocketStarted\) \{\s*throw error;\s*\}\s*recordWebSocketSseFallback\(cacheSessionId\);\s*break;/;
  if (!fallbackBlock.test(source)) throw new Error("Pi transport changed: WS-to-SSE fallback block was not found.");
  source = source.replace(fallbackBlock, "recordWebSocketFailure(cacheSessionId, error);\n\t\t\t\t\t\tthrow error;");
  return source.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
}

function withFastPayload(payload: unknown, onPayload: SimpleStreamOptions["onPayload"] | undefined, model: Model<Api>) {
  const next = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), service_tier: "priority" }
    : payload;
  return onPayload?.(next, model) ?? next;
}

let cachedTransport: Promise<OpenAIResponsesWsTransport> | undefined;

async function loadOpenAIResponsesWsTransport(): Promise<OpenAIResponsesWsTransport> {
  cachedTransport ??= (async () => {
    const original = resolvePiCodexTransport();
    const adapted = rewriteRelativeImports(adaptPiCodexTransportSource(readFileSync(original.path, "utf8")), original.directory);
    const hash = createHash("sha256").update(adapted).digest("hex").slice(0, 16);
    const directory = join(tmpdir(), "coilcoil-openai-responses-ws");
    const path = join(directory, `transport-${hash}.mjs`);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, adapted, "utf8");

    const module = await import(pathToFileURL(path).href) as Partial<OpenAIResponsesWsTransport>;
    if (typeof module.stream !== "function") throw new Error("CoilCoil WS transport 没有导出 stream。");
    if (typeof module.streamSimple !== "function") throw new Error("CoilCoil WS transport 没有导出 streamSimple。");
    return { stream: module.stream, streamSimple: module.streamSimple };
  })().catch((error: unknown) => {
    cachedTransport = undefined;
    throw error;
  });
  return cachedTransport;
}

export async function loadOpenAIResponsesWsStream(fastModelIds: ReadonlySet<string>): Promise<OpenAIResponsesWsStream> {
  const { streamSimple } = await loadOpenAIResponsesWsTransport();
  return (model, context, options) => streamSimple(model, context, {
    ...options,
    transport: "websocket-cached",
    ...(fastModelIds.has(model.id)
      ? { onPayload: (payload, payloadModel) => withFastPayload(payload, options?.onPayload, payloadModel) }
      : {}),
  });
}

/**
 * Registers the standards-based WS transport as a generic Pi api provider (`registerApiProvider`
 * from "@earendil-works/pi-ai/compat") rather than a single named provider, so
 * any custom/override provider can select it as a request protocol and supply
 * its own baseUrl/apiKey/models.
 */
export async function loadOpenAIResponsesWsApiProvider(): Promise<ApiProvider> {
  const { stream, streamSimple } = await loadOpenAIResponsesWsTransport();
  return {
    api: OPENAI_RESPONSES_WS_API as Api,
    stream: (model, context, options) => stream(model, context, { ...options, transport: "websocket-cached" }),
    streamSimple: (model, context, options) => streamSimple(model, context, { ...options, transport: "websocket-cached" }),
  };
}
