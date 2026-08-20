import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OPENAI_RESPONSES_WS_PROVIDER_ID = "openai-responses-ws";
export const OPENAI_RESPONSES_WS_PROVIDER_NAME = "OpenAI Response (WS)";
export const OPENAI_RESPONSES_WS_API = "coilcoil-openai-responses-ws";
export const OPENAI_RESPONSES_WS_CONFIG_FILE = "openai-responses-ws.json";
export const OPENAI_RESPONSES_WS_MODELS_CACHE_FILE = "openai-responses-ws-models.json";
export const LEGACY_CLIPROXYAPI_CONFIG_FILE = "cliproxyapi.json";
export const DEFAULT_OPENAI_RESPONSES_WS_BASE_URL = "http://127.0.0.1:8317";

export interface OpenAIResponsesWsConfigFile {
  baseUrl?: string;
  apiKey?: string;
  fast?: boolean;
}

export interface OpenAIResponsesWsEndpoints {
  inferenceBaseUrl: string;
  modelsUrl: string;
}

function parseObject(path: string): OpenAIResponsesWsConfigFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} 必须包含 JSON 对象。`);
  }
  return parsed as OpenAIResponsesWsConfigFile;
}

/** Read the CoilCoil-owned config and transparently accept the one-time legacy filename. */
export function readOpenAIResponsesWsConfig(agentDir: string): OpenAIResponsesWsConfigFile {
  const path = join(agentDir, OPENAI_RESPONSES_WS_CONFIG_FILE);
  if (existsSync(path)) return parseObject(path);
  const legacyPath = join(agentDir, LEGACY_CLIPROXYAPI_CONFIG_FILE);
  return existsSync(legacyPath) ? parseObject(legacyPath) : {};
}

export function writeOpenAIResponsesWsConfig(agentDir: string, value: OpenAIResponsesWsConfigFile): string {
  const path = join(agentDir, OPENAI_RESPONSES_WS_CONFIG_FILE);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
  try { chmodSync(path, 0o600); } catch { /* Private mode is best effort on non-POSIX filesystems. */ }
  return path;
}

export function resolveOpenAIResponsesWsEndpoints(input: string): OpenAIResponsesWsEndpoints {
  let raw = input.trim();
  if (!raw) throw new Error("Base URL 不能为空。");
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;

  const url = new URL(raw);
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/responses")) path = path.slice(0, -10);
  if (!path || path === "/") path = "/v1";
  else if (!path.endsWith("/v1")) path = `${path}/v1`;
  path = path.replace(/\/{2,}/g, "/");
  return {
    inferenceBaseUrl: `${url.origin}${path}`,
    modelsUrl: `${url.origin}${path}/models?client_version=pi`,
  };
}
