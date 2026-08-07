import { AlertCircle, Check, ChevronDown, ChevronRight, CircleDot, KeyRound, LoaderCircle, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ModelProviderConfiguration,
  ModelProviderConfigurationInput,
  ModelProviderConfigurationSnapshot,
  ModelProviderCredentialConfiguration,
  ModelProviderCredentialField,
  ModelProviderModelConfiguration,
  ModelProviderSaveResult,
  RuntimeConfiguration,
  ThinkingLevel,
} from "@suocode/runtime-protocol";
import { SettingsSelect } from "./SettingsSelect";

type EditableModel = ModelProviderModelConfiguration & { uid: string };
type ProviderDraft = Omit<ModelProviderConfigurationInput["provider"], "models"> & { models: EditableModel[] };

interface ModelAdvancedText {
  thinkingLevelMap: string;
  samplingParams: string;
  headers: string;
  compat: string;
  costTiers: string;
}

const THINKING_OPTIONS: SettingsSelectOption[] = [
  { value: "off", label: "off" },
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

interface SettingsSelectOption {
  value: string;
  label: string;
  detail?: string;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonText(value: unknown): string {
  return value && typeof value === "object" && Object.keys(value).length ? JSON.stringify(value, null, 2) : "{}";
}

function parseJsonObject(value: string, label: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象。`);
  return parsed as Record<string, unknown>;
}

function parseStringMap(value: string, label: string): Record<string, string> | undefined {
  const parsed = parseJsonObject(value, label);
  if (!parsed) return undefined;
  if (Object.values(parsed).some((item) => typeof item !== "string")) throw new Error(`${label}中的值必须全部是字符串。`);
  return parsed as Record<string, string>;
}

function parseCostTiers(value: string, label: string): NonNullable<ModelProviderModelConfiguration["cost"]>["tiers"] | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 数组。`);
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}的第 ${index + 1} 项必须是对象。`);
    const tier = item as Record<string, unknown>;
    const keys = ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"] as const;
    if (keys.some((key) => typeof tier[key] !== "number" || !Number.isFinite(tier[key]))) {
      throw new Error(`${label}的每一项都需要 inputTokensAbove、input、output、cacheRead、cacheWrite 数字字段。`);
    }
    return {
      inputTokensAbove: tier.inputTokensAbove as number,
      input: tier.input as number,
      output: tier.output as number,
      cacheRead: tier.cacheRead as number,
      cacheWrite: tier.cacheWrite as number,
    };
  });
}

function blankModel(): EditableModel {
  return {
    uid: uid(),
    id: "",
    name: "",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function toEditableModel(model: ModelProviderModelConfiguration): EditableModel {
  return { ...clone(model), uid: uid() };
}

function initialAdvancedText(models: EditableModel[]): Record<string, ModelAdvancedText> {
  return Object.fromEntries(models.map((model) => [model.uid, {
    thinkingLevelMap: jsonText(model.thinkingLevelMap),
    samplingParams: jsonText(model.samplingParams),
    headers: jsonText(model.headers),
    compat: jsonText(model.compat),
    costTiers: JSON.stringify(model.cost?.tiers ?? [], null, 2),
  }]));
}

function draftFromProvider(provider: ModelProviderConfiguration): ProviderDraft {
  const { source: _source, apiKeyConfigured: _configured, hasPrivateApiKeyReference: _privateReference, models, ...draft } = provider;
  return { ...clone(draft), models: models.map(toEditableModel) };
}

function blankProvider(index: number): ProviderDraft {
  return {
    id: index === 1 ? "custom-provider" : `custom-provider-${index}`,
    name: "新的服务商",
    baseUrl: "",
    api: "openai-completions",
    headers: {},
    compat: {},
    authHeader: false,
    apiKeyReference: undefined,
    replaceModels: true,
    models: [blankModel()],
    modelOverrides: {},
  };
}

function apiOptions(snapshot: ModelProviderConfigurationSnapshot | undefined): SettingsSelectOption[] {
  return [
    { value: "", label: "继承服务商协议", detail: "仅在模型覆盖时使用" },
    ...(snapshot?.supportedApis ?? []).map((api) => ({ value: api.id, label: api.label, detail: api.description })),
  ];
}

function modelThinkingLevels(model: EditableModel, configuration: RuntimeConfiguration | undefined, providerId: string): ThinkingLevel[] {
  const runtimeModel = configuration?.models.find((item) => item.provider === providerId && item.id === model.id);
  if (runtimeModel?.supportedThinkingLevels.length) return runtimeModel.supportedThinkingLevels;
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap;
  if (map && Object.keys(map).length) return THINKING_OPTIONS.map((item) => item.value as ThinkingLevel).filter((level) => map[level] !== null);
  return ["off", "minimal", "low", "medium", "high"];
}

function sourceLabel(source: ModelProviderConfiguration["source"]): string {
  return source === "custom" ? "自定义" : source === "override" ? "内置覆盖" : "Pi 内置";
}

function customCredentialConfiguration(): ModelProviderCredentialConfiguration {
  return {
    name: "API 密钥",
    selectedMethod: "api-key",
    methods: [{
      id: "api-key",
      label: "API 密钥",
      fields: [{
        id: "key",
        label: "API 密钥",
        input: "secret",
        required: false,
        placeholder: "粘贴 API 密钥；本地服务可留空",
        configured: false,
      }],
    }],
  };
}

function methodFields(
  configuration: ModelProviderCredentialConfiguration,
  method: string,
): ModelProviderCredentialField[] {
  return configuration.methods.find((item) => item.id === method)?.fields ?? [];
}

function NumberInput({ value, onChange, placeholder }: { value?: number; onChange: (value: number | undefined) => void; placeholder?: string }): React.JSX.Element {
  return <input type="number" min="0" value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />;
}

function ProviderCredentialEditor({
  configuration,
  method,
  values,
  configured,
  onMethodChange,
  onValueChange,
}: {
  configuration: ModelProviderCredentialConfiguration;
  method: string;
  values: Record<string, string>;
  configured: boolean;
  onMethodChange: (method: string) => void;
  onValueChange: (field: string, value: string) => void;
}): React.JSX.Element {
  const active = configuration.methods.find((item) => item.id === method) ?? configuration.methods[0];
  return (
    <section className="provider-credential-editor">
      <header>
        <div><strong>连接与认证</strong><small>这里展示当前 Pi 服务商真正需要的认证方式和运行参数，配置保存在 SuoCode 私有运行时中。</small></div>
        <span className={configured ? "configured" : ""}>{configured ? "已配置" : "未配置"}</span>
      </header>
      {configuration.methods.length > 1 ? <label>认证方式<SettingsSelect value={active?.id ?? ""} options={configuration.methods.map((item) => ({ value: item.id, label: item.label, detail: item.description }))} ariaLabel="服务商认证方式" onChange={onMethodChange} /></label> : null}
      {active ? <>
        {configuration.methods.length === 1 ? <div className="provider-credential-method"><strong>{active.label}</strong>{active.description ? <p>{active.description}</p> : null}</div> : active.description ? <p className="provider-credential-description">{active.description}</p> : null}
        {active.fields.length ? <div className="provider-credential-fields">{active.fields.map((field) => <label className={field.input === "textarea" ? "wide" : ""} key={field.id}>
          <span>{field.label}<em className={field.required ? "required" : ""}>{field.required ? "必填" : "可选"}</em></span>
          {field.input === "textarea" ? <textarea value={values[field.id] ?? ""} placeholder={field.placeholder} onChange={(event) => onValueChange(field.id, event.target.value)} /> : field.input === "secret" ? <span className="secret-input"><KeyRound size={14} /><input type="password" value={values[field.id] ?? ""} autoComplete="off" placeholder={field.configured ? "已配置；留空即可保留" : field.placeholder} onChange={(event) => onValueChange(field.id, event.target.value)} /></span> : <input value={values[field.id] ?? ""} placeholder={field.placeholder} onChange={(event) => onValueChange(field.id, event.target.value)} />}
          {field.description ? <small>{field.description}</small> : null}
        </label>)}</div> : <p className="provider-credential-description">此方式使用应用运行环境中已经存在的凭据，不需要在这里填写密钥。</p>}
      </> : <div className="provider-oauth-only"><strong>{configuration.oauth?.label ?? "Pi 订阅登录"}</strong><p>此 Provider 由 Pi 的 OAuth 登录流程认证，不使用 API Key。</p></div>}
      {configuration.oauth && configuration.methods.length ? <div className="provider-oauth-note">Pi 同时支持 <strong>{configuration.oauth.label}</strong> 订阅登录；订阅凭据与 API 密钥是两种独立的登录方式，后一次登录会替换前一次凭据。</div> : null}
    </section>
  );
}

function ProviderModelCard({
  model,
  index,
  apiOptions: options,
  advanced,
  onChange,
  onAdvancedChange,
  onRemove,
}: {
  model: EditableModel;
  index: number;
  apiOptions: SettingsSelectOption[];
  advanced: ModelAdvancedText;
  onChange: (next: EditableModel) => void;
  onAdvancedChange: (next: ModelAdvancedText) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const updateCost = (key: keyof NonNullable<EditableModel["cost"]>, value: number | undefined): void => {
    const current = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    onChange({ ...model, cost: { ...current, [key]: value ?? 0 } });
  };
  const supportsImages = model.input?.includes("image") ?? false;
  const toggleImage = (): void => onChange({ ...model, input: supportsImages ? ["text"] : ["text", "image"] });
  return (
    <article className="provider-model-card">
      <header><span><CircleDot size={14} />模型 {index + 1}</span><button type="button" aria-label={`移除模型 ${index + 1}`} onClick={onRemove}><Trash2 size={14} />移除</button></header>
      <div className="settings-grid provider-model-identity"><label>模型 ID<input value={model.id} placeholder="例如 dog-coder-v1" onChange={(event) => onChange({ ...model, id: event.target.value })} /></label><label>显示名称<input value={model.name ?? ""} placeholder="可选，默认使用模型 ID" onChange={(event) => onChange({ ...model, name: event.target.value })} /></label></div>
      <div className="settings-grid"><label>协议覆盖<SettingsSelect value={model.api ?? ""} options={options} ariaLabel={`模型 ${index + 1} 的协议`} onChange={(api) => onChange({ ...model, api: api || undefined })} searchable /></label><label>模型专用 Base URL<input value={model.baseUrl ?? ""} placeholder="可选，默认继承服务商 Base URL" onChange={(event) => onChange({ ...model, baseUrl: event.target.value })} /></label></div>
      <div className="settings-grid provider-model-capabilities"><label>上下文窗口<NumberInput value={model.contextWindow} placeholder="128000" onChange={(contextWindow) => onChange({ ...model, contextWindow })} /></label><label>最大输出 Token<NumberInput value={model.maxTokens} placeholder="16384" onChange={(maxTokens) => onChange({ ...model, maxTokens })} /></label></div>
      <div className="provider-checkbox-row"><label className="checkbox-setting"><input type="checkbox" checked={Boolean(model.reasoning)} onChange={(event) => onChange({ ...model, reasoning: event.target.checked })} />支持 Thinking / 推理</label><label className="checkbox-setting"><input type="checkbox" checked={supportsImages} onChange={toggleImage} />支持图片输入</label></div>
      <details className="provider-advanced">
        <summary>高级 Pi 模型参数 <ChevronRight size={14} /></summary>
        <p>这些字段直接写入 Pi 的 <code>models.json</code> 模型定义；适合网关兼容性、采样和精确的 Thinking 映射。</p>
        <div className="provider-cost-grid"><label>输入成本 / M Token<NumberInput value={model.cost?.input} onChange={(value) => updateCost("input", value)} /></label><label>输出成本 / M Token<NumberInput value={model.cost?.output} onChange={(value) => updateCost("output", value)} /></label><label>缓存读取 / M Token<NumberInput value={model.cost?.cacheRead} onChange={(value) => updateCost("cacheRead", value)} /></label><label>缓存写入 / M Token<NumberInput value={model.cost?.cacheWrite} onChange={(value) => updateCost("cacheWrite", value)} /></label></div>
        <div className="settings-grid"><label>Thinking 映射 JSON<textarea value={advanced.thinkingLevelMap} placeholder={'{ "high": "high", "max": null }'} onChange={(event) => onAdvancedChange({ ...advanced, thinkingLevelMap: event.target.value })} /></label><label>采样参数 JSON<textarea value={advanced.samplingParams} placeholder={'{ "temperature": 0.7, "top_p": 0.95 }'} onChange={(event) => onAdvancedChange({ ...advanced, samplingParams: event.target.value })} /></label></div>
        <label>成本阶梯 JSON<textarea value={advanced.costTiers} placeholder={'[{ "inputTokensAbove": 272000, "input": 10, "output": 45, "cacheRead": 1, "cacheWrite": 12.5 }]'} onChange={(event) => onAdvancedChange({ ...advanced, costTiers: event.target.value })} /></label>
        <div className="settings-grid"><label>请求头 JSON<textarea value={advanced.headers} placeholder={'{ "X-Gateway": "value" }'} onChange={(event) => onAdvancedChange({ ...advanced, headers: event.target.value })} /></label><label>兼容性 JSON<textarea value={advanced.compat} placeholder={'{ "supportsDeveloperRole": false }'} onChange={(event) => onAdvancedChange({ ...advanced, compat: event.target.value })} /></label></div>
      </details>
    </article>
  );
}

export function ModelSettings({ configuration, onSaved, runtimeId }: {
  configuration?: RuntimeConfiguration;
  onSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ModelProviderConfigurationSnapshot>();
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedSource, setSelectedSource] = useState<ModelProviderConfiguration["source"]>("built-in");
  const [draft, setDraft] = useState<ProviderDraft>();
  const [providerHeadersText, setProviderHeadersText] = useState("{}");
  const [providerCompatText, setProviderCompatText] = useState("{}");
  const [overridesText, setOverridesText] = useState("{}");
  const [modelAdvanced, setModelAdvanced] = useState<Record<string, ModelAdvancedText>>({});
  const [credentialConfiguration, setCredentialConfiguration] = useState<ModelProviderCredentialConfiguration>(customCredentialConfiguration());
  const [credentialMethod, setCredentialMethod] = useState("api-key");
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [credentialPreserveFields, setCredentialPreserveFields] = useState<string[]>([]);
  const [credentialDirty, setCredentialDirty] = useState(false);
  const [preserveApiKeyReference, setPreserveApiKeyReference] = useState(false);
  const [defaultModelId, setDefaultModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [error, setError] = useState<string>();

  const applyProvider = (provider: ModelProviderConfiguration, nextConfiguration = configuration): void => {
    const nextDraft = draftFromProvider(provider);
    setSelectedId(provider.id);
    setSelectedSource(provider.source);
    setDraft(nextDraft);
    setProviderHeadersText(jsonText(provider.headers));
    setProviderCompatText(jsonText(provider.compat));
    setOverridesText(jsonText(provider.modelOverrides));
    setModelAdvanced(initialAdvancedText(nextDraft.models));
    setCredentialConfiguration(provider.credential);
    const nextMethod = provider.credential.selectedMethod ?? provider.credential.methods[0]?.id ?? "";
    const fields = methodFields(provider.credential, nextMethod);
    setCredentialMethod(nextMethod);
    setCredentialValues(Object.fromEntries(fields.flatMap((field) => field.value === undefined ? [] : [[field.id, field.value]])));
    setCredentialPreserveFields(fields.filter((field) => field.input === "secret" && field.configured).map((field) => field.id));
    setCredentialDirty(false);
    setPreserveApiKeyReference(provider.hasPrivateApiKeyReference || Boolean(provider.apiKeyReference));
    const available = nextConfiguration?.models.filter((model) => model.provider === provider.id) ?? [];
    const current = nextConfiguration?.provider === provider.id ? nextConfiguration.modelId : undefined;
    setDefaultModelId(current && available.some((model) => model.id === current) ? current : nextDraft.models[0]?.id ?? available[0]?.id ?? "");
    setThinkingLevel(nextConfiguration?.provider === provider.id ? nextConfiguration.thinkingLevel : "medium");
    setRemoveArmed(false);
    setError(undefined);
  };

  const load = async (preferredId?: string, nextConfiguration = configuration): Promise<void> => {
    setLoading(true);
    try {
      const next = await window.suocode.request<ModelProviderConfigurationSnapshot>({ type: "get_model_provider_configuration" }, runtimeId);
      setSnapshot(next);
      const selected = next.providers.find((provider) => provider.id === preferredId)
        ?? next.providers.find((provider) => provider.id === nextConfiguration?.provider)
        ?? next.providers.find((provider) => provider.apiKeyConfigured)
        ?? next.providers[0];
      if (selected) applyProvider(selected, nextConfiguration);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [runtimeId]);

  const providerOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (snapshot?.providers ?? []).filter((provider) => !normalized || `${provider.id} ${provider.name}`.toLowerCase().includes(normalized));
  }, [query, snapshot]);
  const customProviders = providerOptions.filter((provider) => provider.source === "custom");
  const overrideProviders = providerOptions.filter((provider) => provider.source === "override");
  const builtinProviders = providerOptions.filter((provider) => provider.source === "built-in");
  const protocolOptions = apiOptions(snapshot);
  const defaultModels = useMemo(() => {
    if (!draft) return [] as EditableModel[];
    if (draft.replaceModels) return draft.models;
    const runtime = configuration?.models.filter((model) => model.provider === draft.id) ?? [];
    return runtime.map((model): EditableModel => ({ uid: `runtime-${model.id}`, id: model.id, name: model.name, reasoning: model.reasoning, input: model.supportsImages ? ["text", "image"] : ["text"], contextWindow: model.contextWindow }));
  }, [configuration, draft]);
  const activeDefaultModel = defaultModels.find((model) => model.id === defaultModelId) ?? defaultModels[0];
  const thinkingOptions = activeDefaultModel ? modelThinkingLevels(activeDefaultModel, configuration, draft?.id ?? "").map((level) => THINKING_OPTIONS.find((option) => option.value === level)!).filter(Boolean) : THINKING_OPTIONS.filter((option) => option.value === "off");
  const isPiBuiltinProvider = selectedSource !== "custom";

  const selectProvider = (provider: ModelProviderConfiguration): void => applyProvider(provider);
  const addProvider = (): void => {
    const ids = new Set(snapshot?.providers.map((provider) => provider.id) ?? []);
    let index = 1;
    while (ids.has(index === 1 ? "custom-provider" : `custom-provider-${index}`)) index += 1;
    const next = blankProvider(index);
    setSelectedId(undefined);
    setSelectedSource("custom");
    setDraft(next);
    setProviderHeadersText("{}");
    setProviderCompatText("{}");
    setOverridesText("{}");
    setModelAdvanced(initialAdvancedText(next.models));
    const credential = customCredentialConfiguration();
    setCredentialConfiguration(credential);
    setCredentialMethod(credential.selectedMethod ?? "api-key");
    setCredentialValues({});
    setCredentialPreserveFields([]);
    setCredentialDirty(false);
    setPreserveApiKeyReference(false);
    setDefaultModelId(next.models[0]?.id ?? "");
    setThinkingLevel("medium");
    setRemoveArmed(false);
    setError(undefined);
  };

  const updateModel = (uidValue: string, next: EditableModel): void => setDraft((current) => current ? {
    ...current,
    models: current.models.map((model) => model.uid === uidValue ? next : model),
  } : current);

  const updateCredentialMethod = (method: string): void => {
    const fields = methodFields(credentialConfiguration, method);
    setCredentialMethod(method);
    setCredentialValues(Object.fromEntries(fields.flatMap((field) => field.value === undefined ? [] : [[field.id, field.value]])));
    setCredentialPreserveFields(fields.filter((field) => field.input === "secret" && field.configured).map((field) => field.id));
    setCredentialDirty(true);
  };

  const updateCredentialValue = (field: string, value: string): void => {
    setCredentialValues((current) => ({ ...current, [field]: value }));
    setCredentialDirty(true);
  };

  const buildInput = (): ModelProviderConfigurationInput => {
    if (!draft) throw new Error("服务商配置仍在加载。");
    const models = draft.models.map((model) => {
      const advanced = modelAdvanced[model.uid] ?? { thinkingLevelMap: "{}", samplingParams: "{}", headers: "{}", compat: "{}", costTiers: "[]" };
      const { uid: _uid, ...item } = model;
      return {
        ...item,
        thinkingLevelMap: parseJsonObject(advanced.thinkingLevelMap, `模型 ${model.id || "（未命名）"} 的 Thinking 映射`) as ModelProviderModelConfiguration["thinkingLevelMap"],
        samplingParams: parseJsonObject(advanced.samplingParams, `模型 ${model.id || "（未命名）"} 的采样参数`),
        headers: parseStringMap(advanced.headers, `模型 ${model.id || "（未命名）"} 的请求头`),
        compat: parseJsonObject(advanced.compat, `模型 ${model.id || "（未命名）"} 的兼容性参数`),
        cost: item.cost ? { ...item.cost, tiers: parseCostTiers(advanced.costTiers, `模型 ${model.id || "（未命名）"} 的成本阶梯`) } : undefined,
      };
    });
    return {
      provider: {
        ...draft,
        id: draft.id.trim(),
        name: draft.name?.trim() || undefined,
        baseUrl: draft.baseUrl?.trim() || undefined,
        api: draft.api?.trim() || undefined,
        headers: parseStringMap(providerHeadersText, "服务商请求头"),
        compat: parseJsonObject(providerCompatText, "服务商兼容性参数"),
        modelOverrides: parseJsonObject(overridesText, "模型覆盖 JSON") as ProviderDraft["modelOverrides"],
        models,
      },
      credential: credentialDirty && credentialMethod ? {
        method: credentialMethod,
        values: credentialValues,
        preserveFields: credentialPreserveFields,
      } : undefined,
      preserveApiKeyReference,
    };
  };

  const save = async (applyDefault = false): Promise<ModelProviderSaveResult | undefined> => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await window.suocode.request<ModelProviderSaveResult>({ type: "save_model_provider_configuration", input: buildInput() }, runtimeId);
      onSaved(result.configuration);
      await load(result.provider.id, result.configuration);
      if (applyDefault) {
        const modelId = defaultModelId || result.provider.models[0]?.id;
        if (!modelId) throw new Error("请先添加至少一个模型，再将其设为当前模型。");
        const next = await window.suocode.request<RuntimeConfiguration>({ type: "configure_model", provider: result.provider.id, modelId, thinkingLevel }, runtimeId);
        onSaved(next);
        await load(result.provider.id, next);
      }
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selectedId || selectedSource === "built-in") return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await window.suocode.request<RuntimeConfiguration>({ type: "remove_model_provider_configuration", provider: selectedId }, runtimeId);
      onSaved(next);
      await load(undefined, next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
      setRemoveArmed(false);
    }
  };

  return (
    <div className="model-provider-settings">
      <aside className="provider-catalog">
        <div className="provider-catalog-toolbar"><strong>服务商</strong><button type="button" aria-label="添加自定义服务商" onClick={addProvider}><Plus size={14} />添加</button></div>
        <div className="provider-catalog-search"><Search size={14} /><input value={query} placeholder="搜索服务商" onChange={(event) => setQuery(event.target.value)} /></div>
        {loading ? <p className="settings-loading"><LoaderCircle className="spin" size={15} />加载 Pi 服务商目录…</p> : null}
        {([
          ["自定义服务商", customProviders],
          ["内置覆盖", overrideProviders],
          ["Pi 内置服务商", builtinProviders],
        ] as const).map(([title, providers]) => providers.length ? <section className="provider-catalog-group" key={title}>
          <h2>{title}</h2>
          {providers.map((provider) => <button className={(selectedId === provider.id || (!selectedId && draft?.id === provider.id)) ? "active" : ""} type="button" key={provider.id} onClick={() => selectProvider(provider)}>
            <span><strong>{provider.name ?? provider.id}</strong><small>{provider.id}</small></span>
            <em className={provider.apiKeyConfigured ? "configured" : ""}>{provider.apiKeyConfigured ? "已配置" : sourceLabel(provider.source)}</em>
          </button>)}
        </section> : null)}
      </aside>
      <section className="provider-editor">
        {!draft && !loading ? <div className="provider-editor-empty"><CircleDot size={22} /><strong>{error ? "无法读取 Pi 服务商配置" : "选择或添加一个服务商"}</strong>{error ? <div className="settings-error"><AlertCircle size={14} />{error}</div> : <p>所有配置都会写入 SuoCode 私有运行时的 Pi <code>models.json</code>，不会读取或修改用户的 <code>~/.pi</code>。</p>}</div> : null}
        {draft ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <header className="provider-editor-heading"><div><span className="provider-source-tag">{selectedId ? sourceLabel(selectedSource) : "新的自定义服务商"}</span><strong>{draft.name || draft.id || "未命名服务商"}</strong><small>{isPiBuiltinProvider ? "请求协议与内置模型由 Pi Provider 决定；认证字段和运行参数按该 Provider 的真实实现配置。" : <>使用 Pi 原生 <code>models.json</code> 格式；凭据保存在 SuoCode 私有 <code>auth.json</code>，不会回传到界面。</>}</small></div><div className="provider-editor-actions">{selectedSource !== "built-in" && selectedId ? <button className={removeArmed ? "danger-text-button armed" : "danger-text-button"} type="button" disabled={saving} onClick={() => removeArmed ? void remove() : setRemoveArmed(true)}>{removeArmed ? "再次点击确认移除" : <><Trash2 size={14} />移除</>}</button> : null}<button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{isPiBuiltinProvider ? "保存设置" : "保存服务商"}</button></div></header>
          {isPiBuiltinProvider ? <>
            <div className="provider-native-summary"><strong>Pi 内置服务商</strong><p>“内置”只表示请求实现和模型目录由 Pi 提供，并不表示只填一把密钥。Azure、Vertex、Bedrock 和 Cloudflare 会在下方显示各自真实需要的参数。</p></div>
            <ProviderCredentialEditor configuration={credentialConfiguration} method={credentialMethod} values={credentialValues} configured={Boolean(snapshot?.providers.find((provider) => provider.id === draft.id)?.apiKeyConfigured)} onMethodChange={updateCredentialMethod} onValueChange={updateCredentialValue} />
            <details className="provider-advanced">
              <summary>其他选项 <ChevronRight size={14} /></summary>
              <p>这些选项直接对应 Pi <code>models.json</code> 的服务商覆盖。普通配置不需要填写；“Pi 密钥引用”用于通过环境变量或命令延迟取得密钥，不是另一把 API 密钥。</p>
              <div className="settings-grid"><label>服务地址覆盖（Base URL）<input value={draft.baseUrl ?? ""} placeholder="仅代理或私有网关需要" onChange={(event) => setDraft((current) => current ? { ...current, baseUrl: event.target.value } : current)} /></label><label>Pi 密钥引用<input value={draft.apiKeyReference ?? ""} placeholder="$PROVIDER_KEY 或 !op read …" onChange={(event) => setDraft((current) => current ? { ...current, apiKeyReference: event.target.value || undefined } : current)} /></label></div>
              <div className="provider-checkbox-row"><label className="checkbox-setting"><input type="checkbox" checked={Boolean(draft.authHeader)} onChange={(event) => setDraft((current) => current ? { ...current, authHeader: event.target.checked } : current)} />自动添加 Authorization: Bearer</label><label className="checkbox-setting"><input type="checkbox" checked={preserveApiKeyReference} onChange={(event) => setPreserveApiKeyReference(event.target.checked)} />保留已有 models.json 密钥/引用</label></div>
              <div className="settings-grid"><label>请求头 JSON<textarea value={providerHeadersText} placeholder={'{ "X-Gateway-Key": "$GATEWAY_KEY" }'} onChange={(event) => setProviderHeadersText(event.target.value)} /></label><label>兼容性 JSON<textarea value={providerCompatText} placeholder={'{ "supportsDeveloperRole": false }'} onChange={(event) => setProviderCompatText(event.target.value)} /></label></div>
            </details>
          </> : <>
            <div className="settings-grid"><label>服务商 ID<input value={draft.id} disabled={Boolean(selectedId)} placeholder="例如 dog-provider" onChange={(event) => setDraft((current) => current ? { ...current, id: event.target.value } : current)} /></label><label>显示名称<input value={draft.name ?? ""} placeholder="例如 DogProvider" onChange={(event) => setDraft((current) => current ? { ...current, name: event.target.value } : current)} /></label></div>
            <div className="settings-grid"><label>Pi 请求协议<SettingsSelect value={draft.api ?? ""} options={protocolOptions.filter((option) => option.value)} ariaLabel="Pi 请求协议" placeholder="选择协议" onChange={(api) => setDraft((current) => current ? { ...current, api } : current)} searchable /></label><label>Base URL<input value={draft.baseUrl ?? ""} placeholder="https://api.example.com/v1" onChange={(event) => setDraft((current) => current ? { ...current, baseUrl: event.target.value } : current)} /></label></div>
            <ProviderCredentialEditor configuration={credentialConfiguration} method={credentialMethod} values={credentialValues} configured={Boolean(snapshot?.providers.find((provider) => provider.id === draft.id)?.apiKeyConfigured)} onMethodChange={updateCredentialMethod} onValueChange={updateCredentialValue} />
            <details className="provider-advanced">
              <summary>其他选项 <ChevronRight size={14} /></summary>
              <p>Pi 密钥引用、Radius OAuth、请求头与兼容性参数都属于高级配置。普通 API 密钥请填写上方“连接与认证”。</p>
              <label>Pi 密钥引用<input value={draft.apiKeyReference ?? ""} placeholder="$DOG_PROVIDER_KEY 或 !op read …" onChange={(event) => setDraft((current) => current ? { ...current, apiKeyReference: event.target.value || undefined } : current)} /></label>
              <div className="provider-checkbox-row"><label className="checkbox-setting"><input type="checkbox" checked={Boolean(draft.authHeader)} onChange={(event) => setDraft((current) => current ? { ...current, authHeader: event.target.checked } : current)} />自动添加 Authorization: Bearer</label><label className="checkbox-setting"><input type="checkbox" checked={draft.oauth === "radius"} onChange={(event) => setDraft((current) => current ? { ...current, oauth: event.target.checked ? "radius" : undefined } : current)} />使用 Pi Radius OAuth</label><label className="checkbox-setting"><input type="checkbox" checked={preserveApiKeyReference} onChange={(event) => setPreserveApiKeyReference(event.target.checked)} />保留已有 models.json 密钥/引用</label></div>
              <div className="settings-grid"><label>请求头 JSON<textarea value={providerHeadersText} placeholder={'{ "X-Gateway-Key": "$GATEWAY_KEY" }'} onChange={(event) => setProviderHeadersText(event.target.value)} /></label><label>兼容性 JSON<textarea value={providerCompatText} placeholder={'{ "supportsDeveloperRole": false }'} onChange={(event) => setProviderCompatText(event.target.value)} /></label></div>
            </details>
          </>}
          <section className="provider-models-section">
            <header><div><strong>模型目录</strong><small>{draft.replaceModels ? "此目录会写入 Pi models.json，并替换该服务商的默认模型目录。" : "保留 Pi 内置模型目录；如需自定义模型，请启用自定义目录。"}</small></div><div className="provider-model-mode"><button className={!draft.replaceModels ? "active" : ""} type="button" onClick={() => setDraft((current) => current ? { ...current, replaceModels: false } : current)}>保留内置</button><button className={draft.replaceModels ? "active" : ""} type="button" onClick={() => setDraft((current) => {
              if (!current) return current;
              return { ...current, replaceModels: true, models: current.models.length ? current.models : [blankModel()] };
            })}>自定义目录</button></div></header>
            {draft.replaceModels ? <><div className="provider-model-list">{draft.models.map((model, index) => <ProviderModelCard key={model.uid} model={model} index={index} apiOptions={protocolOptions} advanced={modelAdvanced[model.uid] ?? { thinkingLevelMap: "{}", samplingParams: "{}", headers: "{}", compat: "{}", costTiers: "[]" }} onChange={(next) => updateModel(model.uid, next)} onAdvancedChange={(next) => setModelAdvanced((current) => ({ ...current, [model.uid]: next }))} onRemove={() => { setDraft((current) => current ? { ...current, models: current.models.filter((item) => item.uid !== model.uid) } : current); setModelAdvanced((current) => { const { [model.uid]: _removed, ...rest } = current; return rest; }); }} />)}</div><button className="add-model-button" type="button" onClick={() => { const next = blankModel(); setDraft((current) => current ? { ...current, models: [...current.models, next] } : current); setModelAdvanced((current) => ({ ...current, ...initialAdvancedText([next]) })); }}><Plus size={14} />添加模型</button></> : <><div className="provider-builtins-summary">当前 Pi 内置目录包含 {defaultModels.length} 个模型。启用“自定义目录”后，你可以只保留需要展示的模型。</div><details className="provider-advanced"><summary>按模型覆盖 Pi 参数 <ChevronRight size={14} /></summary><p>保留内置目录时，使用 <code>modelOverrides</code> 为任意内置模型配置上下文、输出上限、图片能力、采样或兼容性参数。</p><label>modelOverrides JSON<textarea value={overridesText} placeholder={'{\n  "gpt-5.6": { "contextWindow": 128000, "maxTokens": 16384 }\n}'} onChange={(event) => setOverridesText(event.target.value)} /></label></details></>}
          </section>
          <section className="provider-default-model">
            <div><strong>当前使用的模型</strong><small>保存配置后可直接将一个模型设为 SuoCode 当前默认模型。</small></div>
            <div className="settings-grid"><label>模型<SettingsSelect value={defaultModelId} options={defaultModels.map((model) => ({ value: model.id, label: model.name || model.id, detail: model.id }))} ariaLabel="当前默认模型" placeholder="请选择模型" onChange={(modelId) => { setDefaultModelId(modelId); const selected = defaultModels.find((model) => model.id === modelId); const levels: ThinkingLevel[] = selected ? modelThinkingLevels(selected, configuration, draft.id) : ["off"]; setThinkingLevel((current) => levels.includes(current) ? current : levels[0]); }} searchable /></label><label>Thinking<SettingsSelect value={thinkingLevel} options={thinkingOptions} ariaLabel="Thinking 强度" onChange={(value) => setThinkingLevel(value as ThinkingLevel)} disabled={thinkingOptions.length <= 1} /></label></div>
            <button className="secondary-button" type="button" disabled={saving || !defaultModelId} onClick={() => void save(true)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存并设为当前模型</button>
          </section>
          {error ? <div className="settings-error"><AlertCircle size={14} />{error}</div> : null}
          <footer><span>{snapshot?.configPath}</span><span className="provider-runtime-note">Pi 内置协议、模型覆盖和凭据都在 SuoCode 私有运行时中处理。</span></footer>
        </form> : null}
      </section>
    </div>
  );
}
