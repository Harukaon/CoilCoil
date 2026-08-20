import {
  type ApiKeyCredential,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  OPENAI_RESPONSES_WS_API,
  OPENAI_RESPONSES_WS_PROVIDER_NAME,
} from "@coilcoil/openai-responses-ws/config";
import {
  type ModelProviderAuthState,
  type ModelProviderConfigurationSnapshot,
  type ModelProviderCredentialConfiguration,
  type ModelProviderCredentialField,
  type ModelProviderCredentialMethod,
  type ModelProviderModelConfiguration,
  type ThinkingLevel,
} from "@coilcoil/runtime-protocol";
import {
  MASKED_CONFIGURATION_VALUE
} from "./runtime-constants.js";
import {
  isRecord,
  objectValue,
  optionalBoolean,
  optionalPositiveNumber,
  optionalString,
  safeUnknownRecord,
  stringRecord
} from "./runtime-utils.js";

export { MASKED_CONFIGURATION_VALUE } from "./runtime-constants.js";

export const MODEL_PROVIDER_APIS: ModelProviderConfigurationSnapshot["supportedApis"] = [
  { id: "openai-completions", label: "OpenAI Chat Completions", description: "兼容性最高，适合绝大多数 OpenAI 兼容服务。" },
  { id: "openai-responses", label: "OpenAI Responses", description: "OpenAI Responses API。" },
  { id: "azure-openai-responses", label: "Azure OpenAI Responses", description: "Azure OpenAI 的 Responses API。" },
  { id: "openai-codex-responses", label: "OpenAI Codex Responses", description: "OpenAI Codex 专用 Responses 流。" },
  { id: "anthropic-messages", label: "Anthropic Messages", description: "Anthropic Claude API 及兼容网关。" },
  { id: "google-generative-ai", label: "Google Generative AI", description: "Google AI Studio / Generative Language API。" },
  { id: "google-vertex", label: "Google Vertex AI", description: "Google Vertex AI。" },
  { id: "mistral-conversations", label: "Mistral Conversations", description: "Mistral 原生 Conversations API。" },
  { id: "bedrock-converse-stream", label: "Amazon Bedrock Converse", description: "Amazon Bedrock Converse Stream API。" },
  { id: "pi-messages", label: "Messages", description: "原生 Messages 流协议，适用于实现该协议的私有服务。" },
  { id: OPENAI_RESPONSES_WS_API, label: OPENAI_RESPONSES_WS_PROVIDER_NAME, description: "CoilCoil 的 WebSocket 协议扩展；任何实现该协议的服务都可以直接作为自定义服务商接入，无需 ChatGPT 账号。" },
];

export type CredentialFieldDefinition = Omit<ModelProviderCredentialField, "configured" | "value">;

export type CredentialMethodDefinition = Omit<ModelProviderCredentialMethod, "fields"> & {
  fields: CredentialFieldDefinition[];
};

export const credentialField = (
  id: string,
  label: string,
  input: CredentialFieldDefinition["input"],
  required: boolean,
  placeholder?: string,
  description?: string,
): CredentialFieldDefinition => ({ id, label, input, required, placeholder, description });

export const BUILTIN_CREDENTIAL_METHODS: Record<string, CredentialMethodDefinition[]> = {
  "azure-openai-responses": [{
    id: "api-key",
    label: "Azure OpenAI API Key",
    description: "API 密钥负责认证；Azure 端点与资源名决定请求发送到哪里，两者至少填写一项。",
    fields: [
      credentialField("key", "API 密钥", "secret", true, "Azure OpenAI API Key"),
      credentialField("AZURE_OPENAI_BASE_URL", "Azure 端点", "text", false, "https://your-resource.openai.azure.com", "支持 Azure OpenAI、Cognitive Services 与 Azure AI 根地址；会自动规范化为 /openai/v1。"),
      credentialField("AZURE_OPENAI_RESOURCE_NAME", "Azure 资源名", "text", false, "your-resource", "不填写端点时，会由资源名生成 Azure OpenAI 地址。"),
      credentialField("AZURE_OPENAI_API_VERSION", "API 版本", "text", false, "留空使用 v1", "对应 AZURE_OPENAI_API_VERSION。"),
      credentialField("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "模型与部署名映射", "textarea", false, "gpt-4o=my-gpt4o,gpt-5=my-gpt5", "仅当 Azure Deployment 名称与模型 ID 不一致时填写，多个映射使用逗号分隔。"),
    ],
  }],
  "cloudflare-ai-gateway": [{
    id: "api-key",
    label: "Cloudflare AI Gateway",
    description: "对应 Cloudflare AI Gateway 登录流程。三个字段都参与请求认证。",
    fields: [
      credentialField("key", "Cloudflare API Token", "secret", true, "Cloudflare API Token"),
      credentialField("CLOUDFLARE_ACCOUNT_ID", "Account ID", "text", true, "Cloudflare Account ID"),
      credentialField("CLOUDFLARE_GATEWAY_ID", "Gateway ID", "text", true, "AI Gateway slug"),
    ],
  }],
  "cloudflare-workers-ai": [{
    id: "api-key",
    label: "Cloudflare Workers AI",
    description: "对应 Cloudflare Workers AI 登录流程。",
    fields: [
      credentialField("key", "Cloudflare API Token", "secret", true, "Cloudflare API Token"),
      credentialField("CLOUDFLARE_ACCOUNT_ID", "Account ID", "text", true, "Cloudflare Account ID"),
    ],
  }],
  "google-vertex": [
    {
      id: "api-key",
      label: "Google Cloud API Key",
      description: "使用 Vertex Express Mode API Key；不需要 ADC 项目与区域参数。",
      fields: [credentialField("key", "API 密钥", "secret", true, "Google Cloud API Key")],
    },
    {
      id: "adc",
      label: "Application Default Credentials",
      description: "使用 gcloud application-default login 创建的本机 ADC。",
      fields: [
        credentialField("GOOGLE_CLOUD_PROJECT", "Project ID", "text", true, "my-gcp-project"),
        credentialField("GOOGLE_CLOUD_LOCATION", "Location", "text", true, "us-central1"),
      ],
    },
    {
      id: "service-account",
      label: "Service Account 文件",
      description: "使用服务账号 JSON 文件以及明确的项目和区域。",
      fields: [
        credentialField("GOOGLE_APPLICATION_CREDENTIALS", "凭据文件路径", "text", true, "/absolute/path/service-account.json"),
        credentialField("GOOGLE_CLOUD_PROJECT", "Project ID", "text", true, "my-gcp-project"),
        credentialField("GOOGLE_CLOUD_LOCATION", "Location", "text", true, "us-central1"),
      ],
    },
  ],
  "amazon-bedrock": [
    {
      id: "bearer-token",
      label: "Bedrock Bearer Token",
      description: "对应 Bearer token 登录方式。",
      fields: [
        credentialField("key", "Bearer Token", "secret", true, "AWS Bedrock bearer token"),
        credentialField("AWS_REGION", "AWS Region", "text", false, "us-east-1"),
      ],
    },
    {
      id: "aws-profile",
      label: "AWS Profile",
      description: "使用 ~/.aws 中已配置的 Profile；Profile 名称会保存在 CoilCoil 私有凭据中。",
      fields: [
        credentialField("AWS_PROFILE", "Profile 名称", "text", true, "default"),
        credentialField("AWS_REGION", "AWS Region", "text", false, "us-east-1"),
      ],
    },
    {
      id: "iam-keys",
      label: "IAM 访问密钥",
      description: "使用 AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY 和可选的 Session Token。",
      fields: [
        credentialField("AWS_ACCESS_KEY_ID", "Access Key ID", "secret", true, "AKIA…"),
        credentialField("AWS_SECRET_ACCESS_KEY", "Secret Access Key", "secret", true, "AWS Secret Access Key"),
        credentialField("AWS_SESSION_TOKEN", "Session Token", "secret", false, "临时凭据使用，可选"),
        credentialField("AWS_REGION", "AWS Region", "text", false, "us-east-1"),
      ],
    },
    {
      id: "credential-chain",
      label: "现有 AWS Credential Chain",
      description: "使用运行环境已有的 IAM、ECS Task Role 或 Web Identity 凭据，不在 CoilCoil 中保存密钥。",
      fields: [credentialField("AWS_REGION", "AWS Region", "text", false, "us-east-1")],
    },
  ],
};

export function selectedCredentialMethod(providerId: string, credential: ApiKeyCredential | undefined): string | undefined {
  const methods = BUILTIN_CREDENTIAL_METHODS[providerId];
  if (!methods?.length) return credential ? "api-key" : undefined;
  if (providerId === "amazon-bedrock") {
    if (credential?.key) return "bearer-token";
    if (credential?.env?.AWS_PROFILE) return "aws-profile";
    if (credential?.env?.AWS_ACCESS_KEY_ID || credential?.env?.AWS_SECRET_ACCESS_KEY) return "iam-keys";
    return credential ? "credential-chain" : methods[0].id;
  }
  if (providerId === "google-vertex") {
    if (credential?.key) return "api-key";
    if (credential?.env?.GOOGLE_APPLICATION_CREDENTIALS) return "service-account";
    if (credential?.env?.GOOGLE_CLOUD_PROJECT || credential?.env?.GOOGLE_CLOUD_LOCATION) return "adc";
  }
  return methods[0].id;
}

export function credentialMethodsForProvider(provider: Provider | undefined): CredentialMethodDefinition[] {
  if (!provider?.auth.apiKey) return [];
  return BUILTIN_CREDENTIAL_METHODS[provider.id] ?? [{
    id: "api-key",
    label: provider.auth.apiKey.name || "API 密钥",
    fields: [credentialField("key", provider.auth.apiKey.name || "API 密钥", "secret", true, "粘贴 API 密钥")],
  }];
}

export function credentialConfiguration(
  provider: Provider | undefined,
  credential: ApiKeyCredential | undefined,
): ModelProviderCredentialConfiguration {
  const methods = credentialMethodsForProvider(provider);
  return {
    name: provider?.auth.apiKey?.name,
    selectedMethod: selectedCredentialMethod(provider?.id ?? "", credential) ?? methods[0]?.id,
    methods: methods.map((method) => ({
      ...method,
      fields: method.fields.map((field) => {
        const raw = field.id === "key" ? credential?.key : credential?.env?.[field.id];
        return {
          ...field,
          configured: Boolean(raw),
          value: field.input === "secret" ? undefined : raw,
        };
      }),
    })),
    oauth: provider?.auth.oauth ? {
      name: provider.auth.oauth.name,
      label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
    } : undefined,
  };
}

export interface PrivateModelsConfiguration {
  providers: Record<string, Record<string, unknown>>;
}

export interface ProviderAuthFlow {
  state: ModelProviderAuthState;
  controller: AbortController;
  pendingPrompt?: {
    id: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  };
}

export function thinkingLevelMap(value: unknown): Partial<Record<ThinkingLevel, string | null>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [ThinkingLevel, string | null] =>
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(entry[0])
    && (typeof entry[1] === "string" || entry[1] === null),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function modelCost(value: unknown): ModelProviderModelConfiguration["cost"] | undefined {
  if (!isRecord(value)) return undefined;
  const input = typeof value.input === "number" ? value.input : undefined;
  const output = typeof value.output === "number" ? value.output : undefined;
  const cacheRead = typeof value.cacheRead === "number" ? value.cacheRead : undefined;
  const cacheWrite = typeof value.cacheWrite === "number" ? value.cacheWrite : undefined;
  const tiers = Array.isArray(value.tiers)
    ? value.tiers.flatMap((tier) => {
      if (!isRecord(tier)) return [];
      const inputTokensAbove = typeof tier.inputTokensAbove === "number" ? tier.inputTokensAbove : undefined;
      const tierInput = typeof tier.input === "number" ? tier.input : undefined;
      const tierOutput = typeof tier.output === "number" ? tier.output : undefined;
      const tierCacheRead = typeof tier.cacheRead === "number" ? tier.cacheRead : undefined;
      const tierCacheWrite = typeof tier.cacheWrite === "number" ? tier.cacheWrite : undefined;
      return inputTokensAbove === undefined || tierInput === undefined || tierOutput === undefined || tierCacheRead === undefined || tierCacheWrite === undefined
        ? []
        : [{ inputTokensAbove, input: tierInput, output: tierOutput, cacheRead: tierCacheRead, cacheWrite: tierCacheWrite }];
    })
    : undefined;
  return input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined
    ? undefined
    : { input, output, cacheRead, cacheWrite, tiers: tiers?.length ? tiers : undefined };
}

export function modelConfiguration(value: unknown, fallbackId?: string): ModelProviderModelConfiguration | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value, "id") ?? fallbackId;
  if (!id) return undefined;
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : undefined;
  return {
    id,
    name: optionalString(value, "name"),
    api: optionalString(value, "api"),
    baseUrl: optionalString(value, "baseUrl"),
    reasoning: optionalBoolean(value, "reasoning"),
    thinkingLevelMap: thinkingLevelMap(value.thinkingLevelMap),
    input: input?.length ? input : undefined,
    contextWindow: optionalPositiveNumber(value, "contextWindow"),
    maxTokens: optionalPositiveNumber(value, "maxTokens"),
    cost: modelCost(value.cost),
    samplingParams: safeUnknownRecord(value.samplingParams),
    headers: stringRecord(value.headers, true),
    compat: safeUnknownRecord(value.compat),
  };
}

export function modelConfigurationForStorage(
  model: ModelProviderModelConfiguration,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const headers = mergeMaskedStringRecord(model.headers, objectValue(existing?.headers));
  const result: Record<string, unknown> = {
    id: model.id.trim(),
  };
  const assign = (key: string, value: unknown): void => {
    if (value !== undefined && value !== "") result[key] = value;
  };
  assign("name", model.name?.trim());
  assign("api", model.api?.trim());
  assign("baseUrl", model.baseUrl?.trim());
  assign("reasoning", model.reasoning);
  assign("thinkingLevelMap", model.thinkingLevelMap);
  assign("input", model.input?.length ? model.input : undefined);
  assign("contextWindow", model.contextWindow);
  assign("maxTokens", model.maxTokens);
  assign("cost", model.cost);
  assign("samplingParams", model.samplingParams);
  assign("headers", Object.keys(headers).length ? headers : undefined);
  assign("compat", model.compat);
  return result;
}

export function mergeMaskedStringRecord(
  value: Record<string, string> | undefined,
  existing: Record<string, unknown> | undefined,
): Record<string, string> {
  const previous = stringRecord(existing) ?? {};
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, entry]) => [
    key,
    entry === MASKED_CONFIGURATION_VALUE && previous[key] !== undefined ? previous[key] : entry,
  ]));
}

export function assertProviderId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error("服务商 ID 只能使用字母、数字、点、短横线或下划线，并且必须以字母或数字开头。");
  }
  return id;
}

export function assertOptionalUrl(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Unsupported protocol");
  } catch {
    throw new Error(`${label}必须是完整的 http:// 或 https:// 地址。`);
  }
  return normalized;
}

export function isOpenAiCompatibleProviderApi(api: string): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

export function joinProviderUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

export function modelListUrlCandidates(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  const withoutV1 = normalized.replace(/\/v1$/i, "");
  const withV1 = /\/v1$/i.test(normalized) ? normalized : `${withoutV1}/v1`;
  const bases = [...new Set([normalized, withoutV1, withV1].filter(Boolean))];
  return [...new Set(bases.map((base) => joinProviderUrl(base, "models")))];
}

export function modelListAuthHeaderVariants(
  baseHeaders: Record<string, string>,
  apiKey: string | undefined,
  api: string | undefined,
): Record<string, string>[] {
  const hasAuth = Object.keys(baseHeaders).some((key) => {
    const lower = key.toLowerCase();
    return lower === "authorization" || lower === "x-api-key";
  });
  if (hasAuth || !apiKey) return [baseHeaders];

  const bearer = { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
  const anthropic = {
    ...baseHeaders,
    "x-api-key": apiKey,
    "anthropic-version": baseHeaders["anthropic-version"] ?? baseHeaders["Anthropic-Version"] ?? "2023-06-01",
  };
  if ((api ?? "").includes("anthropic")) return [anthropic, bearer];
  return [bearer, anthropic];
}

export function truncateDetail(value: string, max = 280): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function parseUpstreamModelList(value: unknown): Array<{ id: string; name?: string; }> {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : isRecord(value) && Array.isArray(value.models)
        ? value.models
        : [];
  const models: Array<{ id: string; name?: string; }> = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (typeof item === "string") {
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id });
      continue;
    }
    if (!isRecord(item)) continue;
    const id = optionalString(item, "id") ?? optionalString(item, "name");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = optionalString(item, "name");
    models.push({ id, name: name && name !== id ? name : undefined });
  }
  return models;
}
