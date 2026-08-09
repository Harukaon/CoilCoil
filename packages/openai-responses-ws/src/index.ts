import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_OPENAI_RESPONSES_WS_BASE_URL,
  OPENAI_RESPONSES_WS_API,
  OPENAI_RESPONSES_WS_MODELS_CACHE_FILE,
  OPENAI_RESPONSES_WS_PROVIDER_ID,
  OPENAI_RESPONSES_WS_PROVIDER_NAME,
  readOpenAIResponsesWsConfig,
  resolveOpenAIResponsesWsEndpoints,
} from "./config.ts";
import { fetchOpenAIResponsesWsCatalog, type OpenAIResponsesWsCatalog } from "./models.ts";
import { loadOpenAIResponsesWsStream } from "./transport.ts";

interface CatalogCache extends OpenAIResponsesWsCatalog {
  modelsUrl: string;
  fetchedAt: number;
}

function readCatalogCache(agentDir: string, modelsUrl: string): CatalogCache | undefined {
  const path = join(agentDir, OPENAI_RESPONSES_WS_MODELS_CACHE_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CatalogCache;
    return parsed.modelsUrl === modelsUrl && Array.isArray(parsed.models) && Array.isArray(parsed.fastModelIds)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function writeCatalogCache(agentDir: string, modelsUrl: string, catalog: OpenAIResponsesWsCatalog): void {
  const path = join(agentDir, OPENAI_RESPONSES_WS_MODELS_CACHE_FILE);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify({ ...catalog, modelsUrl, fetchedAt: Date.now() }, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

async function register(pi: ExtensionAPI, options: {
  apiKey: string;
  baseUrl: string;
  fast: boolean;
  catalog: OpenAIResponsesWsCatalog;
}): Promise<void> {
  const fastModelIds = options.fast ? new Set(options.catalog.fastModelIds) : new Set<string>();
  const streamSimple = await loadOpenAIResponsesWsStream(fastModelIds);
  pi.unregisterProvider(OPENAI_RESPONSES_WS_PROVIDER_ID);
  pi.registerProvider(OPENAI_RESPONSES_WS_PROVIDER_ID, {
    name: OPENAI_RESPONSES_WS_PROVIDER_NAME,
    api: OPENAI_RESPONSES_WS_API as Api,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    models: options.catalog.models,
    streamSimple,
  });
}

export default async function openAIResponsesWsExtension(pi: ExtensionAPI): Promise<void> {
  const agentDir = getAgentDir();
  const config = readOpenAIResponsesWsConfig(agentDir);
  const apiKey = config.apiKey?.trim();
  if (!apiKey) return;

  const endpoints = resolveOpenAIResponsesWsEndpoints(config.baseUrl ?? DEFAULT_OPENAI_RESPONSES_WS_BASE_URL);
  const cached = readCatalogCache(agentDir, endpoints.modelsUrl);
  if (cached) {
    await register(pi, { apiKey, baseUrl: endpoints.inferenceBaseUrl, fast: config.fast === true, catalog: cached });
    void fetchOpenAIResponsesWsCatalog(endpoints.modelsUrl, apiKey).then(async (catalog) => {
      writeCatalogCache(agentDir, endpoints.modelsUrl, catalog);
      await register(pi, { apiKey, baseUrl: endpoints.inferenceBaseUrl, fast: config.fast === true, catalog });
    }).catch((error) => console.warn(`[OpenAI Response (WS)] 模型目录后台刷新失败：${error instanceof Error ? error.message : String(error)}`));
    return;
  }

  const catalog = await fetchOpenAIResponsesWsCatalog(endpoints.modelsUrl, apiKey);
  writeCatalogCache(agentDir, endpoints.modelsUrl, catalog);
  await register(pi, { apiKey, baseUrl: endpoints.inferenceBaseUrl, fast: config.fast === true, catalog });
}
