import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { OPENAI_RESPONSES_WS_API, OPENAI_RESPONSES_WS_PROVIDER_ID } from "./config.ts";

export type OpenAIResponsesWsStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

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
 * Build SuoCode's extension transport from the bundled Pi protocol implementation.
 * The extension changes only the authentication assumption and transport policy:
 * ordinary proxy keys are valid, account-id is optional, and requests stay on WS.
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

export async function loadOpenAIResponsesWsStream(fastModelIds: ReadonlySet<string>): Promise<OpenAIResponsesWsStream> {
  const original = resolvePiCodexTransport();
  const adapted = rewriteRelativeImports(adaptPiCodexTransportSource(readFileSync(original.path, "utf8")), original.directory);
  const hash = createHash("sha256").update(adapted).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), "suocode-openai-responses-ws");
  const path = join(directory, `transport-${hash}.mjs`);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, adapted, "utf8");

  const module = await import(pathToFileURL(path).href) as { streamSimple?: OpenAIResponsesWsStream };
  if (typeof module.streamSimple !== "function") throw new Error("SuoCode WS transport 没有导出 streamSimple。");
  return (model, context, options) => module.streamSimple!(model, context, {
    ...options,
    transport: "websocket-cached",
    ...(fastModelIds.has(model.id)
      ? { onPayload: (payload, payloadModel) => withFastPayload(payload, options?.onPayload, payloadModel) }
      : {}),
  });
}
