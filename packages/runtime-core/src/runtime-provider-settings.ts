import {
  type ApiKeyCredential,
  clampThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import {
  AuthStorage,
  ModelRuntime,
  SettingsManager,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import {
  OPENAI_RESPONSES_WS_PROVIDER_ID,
} from "@coilcoil/openai-responses-ws/config";
import {
  type ModelProviderConfiguration,
  type ModelProviderConfigurationInput,
  type ModelProviderConfigurationSnapshot,
  type ModelProviderModelConfiguration,
  type ModelProviderPatchInput,
  type ModelProviderSaveResult,
  type PendingSessionModel,
  type RuntimeConfiguration,
  type SummarizationModelConfiguration,
  type SummarizationModelConfigurationInput,
  type ThinkingLevel,
} from "@coilcoil/runtime-protocol";
import {
  join,
} from "node:path";
import {
  MODEL_PROVIDER_APIS,
  assertOptionalUrl,
  assertProviderId,
  credentialMethodsForProvider,
  mergeMaskedStringRecord,
  modelConfigurationForStorage,
} from "./provider-helpers.js";
import { RuntimeProviderCore } from "./runtime-provider-core.js";
import {
  parseModelReference,
  readSummarizationModelConfiguration,
  writeSummarizationModelConfiguration,
} from "./summarization-model.js";
import {
  cloneJson,
  errorMessage,
  isRecord,
  objectValue,
  optionalString,
} from "./runtime-utils.js";
import type { ActiveSession } from "./runtime-state.js";

export abstract class RuntimeProviderSettings extends RuntimeProviderCore {
  /** 压缩和分支摘要跑在哪个模型上；空表示跟随会话模型。 */
  async getSummarizationModelConfiguration(): Promise<SummarizationModelConfiguration> {
    return this.summarizationModelState();
  }

  async saveSummarizationModelConfiguration(
    input: SummarizationModelConfigurationInput,
  ): Promise<SummarizationModelConfiguration> {
    writeSummarizationModelConfiguration(this.agentDir, input);
    await this.applySummarizationModel();
    return this.summarizationModelState();
  }

  /** What the panel should show: what was configured, and whether it is usable. */
  protected summarizationModelState(): SummarizationModelConfiguration {
    const configured = readSummarizationModelConfiguration(this.agentDir);
    if (!configured.model || !this.active) return configured;
    return { ...configured, unavailable: this.active.summarizationModelUnavailable === true };
  }

  /**
   * Point this session's summaries at the configured model.
   *
   * A model that cannot be resolved — deleted from the provider, credentials
   * gone — must not take compaction down with it: the session falls back to its
   * own model and says so in the panel. A compaction that does not happen is
   * how a session walks into a context overflow.
   */
  protected async applySummarizationModel(active = this.active): Promise<void> {
    if (!active) return;
    const configured = readSummarizationModelConfiguration(this.agentDir).model;
    const resolved = await this.resolveSummarizationModel(configured);
    if (this.active !== active) return;
    active.session.summarizationModel = resolved;
    active.summarizationModelUnavailable = Boolean(configured) && !resolved;
    if (active.summarizationModelUnavailable) {
      this.log.warn("compaction", "summarization_model_unavailable", { configured });
    } else if (resolved) {
      this.log.info("compaction", "summarization_model_applied", { model: `${resolved.provider}/${resolved.id}` });
    }
    this.publishRuntimeInspection(active);
  }

  private async resolveSummarizationModel(configured: string) {
    const reference = configured ? parseModelReference(configured) : undefined;
    if (!reference) return undefined;
    try {
      const modelRuntime = await this.ready();
      const model = modelRuntime.getModel(reference.provider, reference.id);
      // Context-window overrides are CoilCoil metadata, not registry data; the
      // summary model needs them for the same reason the session model does.
      return model ? this.modelWithRuntimeOptions(model) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 模型表或凭证变了，配置的总结模型也要重新解析一次。 */
  override refreshSessionModelFromRegistry(): void {
    super.refreshSessionModelFromRegistry();
    void this.applySummarizationModel().catch(() => undefined);
  }

  async getModelProviderConfiguration(): Promise<ModelProviderConfigurationSnapshot> {
    const modelRuntime = await this.ready();
    const privateConfiguration = this.readPrivateModelsConfiguration();
    const builtinIds = new Set<string>([...getBuiltinProviders(), "radius", OPENAI_RESPONSES_WS_PROVIDER_ID]);
    const providers = new Map(modelRuntime.getProviders().map((provider) => [provider.id, provider]));
    const allModels = modelRuntime.getModels();
    const models = new Map<string, Array<(typeof allModels)[number]>>();
    for (const model of modelRuntime.getModels()) {
      const values = models.get(model.provider) ?? [];
      values.push(model);
      models.set(model.provider, values);
    }
    const ids = new Set([...providers.keys(), ...Object.keys(privateConfiguration.providers), OPENAI_RESPONSES_WS_PROVIDER_ID]);
    const configuration = [...ids].map((id) => this.modelProviderFromConfiguration(
      id,
      privateConfiguration.providers[id],
      models.get(id) ?? [],
      providers.get(id),
      builtinIds,
      modelRuntime,
    )).sort((left, right) => {
      const rank = (source: ModelProviderConfiguration["source"]): number => source === "custom" ? 0 : source === "override" ? 1 : 2;
      return rank(left.source) - rank(right.source) || Number(right.apiKeyConfigured) - Number(left.apiKeyConfigured) || left.name!.localeCompare(right.name!);
    });
    return {
      configPath: this.modelsConfigurationPath(),
      providers: configuration,
      supportedApis: MODEL_PROVIDER_APIS,
    };
  }

  protected validateModelProviderConfiguration(
    input: ModelProviderConfigurationInput,
    existing: Record<string, unknown> | undefined,
    builtinIds: ReadonlySet<string>,
  ): { id: string; provider: Record<string, unknown>; writeModelsConfig: boolean; } {
    const draft = input.provider;
    const id = assertProviderId(draft.id);
    const isBuiltin = builtinIds.has(id);
    const baseUrl = assertOptionalUrl(draft.baseUrl, "Base URL");
    const api = draft.api?.trim() || undefined;
    const knownApis = new Set(MODEL_PROVIDER_APIS.map((option) => option.id));
    if (api && !knownApis.has(api)) throw new Error(`“${api}”不是当前支持的请求协议。`);
    if (draft.oauth && draft.oauth !== "radius") throw new Error("当前仅支持 radius OAuth 服务商。");

    const seenModelIds = new Set<string>();
    const models = draft.models.map((model) => {
      const modelId = model.id.trim();
      if (!modelId) throw new Error("每个模型都需要模型 ID。`id` 会原样发送给服务商。");
      if (seenModelIds.has(modelId)) throw new Error(`模型 ID “${modelId}”重复。`);
      seenModelIds.add(modelId);
      const modelApi = model.api?.trim();
      if (modelApi && !knownApis.has(modelApi)) throw new Error(`模型 ${modelId} 使用了不支持的请求协议“${modelApi}”。`);
      assertOptionalUrl(model.baseUrl, `模型 ${modelId} 的 Base URL`);
      if (model.input?.length && !model.input.includes("text")) throw new Error(`模型 ${modelId} 至少需要支持文本输入。`);
      for (const [label, value] of [["上下文窗口", model.contextWindow], ["最大输出", model.maxTokens]] as const) {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`模型 ${modelId} 的${label}必须是大于 0 的数字。`);
      }
      if (model.cost && [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error(`模型 ${modelId} 的成本参数必须是非负数字。`);
      }
      if (model.cost?.tiers?.some((tier) => !Number.isFinite(tier.inputTokensAbove) || tier.inputTokensAbove < 0 || [tier.input, tier.output, tier.cacheRead, tier.cacheWrite].some((value) => !Number.isFinite(value) || value < 0))) {
        throw new Error(`模型 ${modelId} 的成本阶梯参数必须是非负数字。`);
      }
      return model;
    });
    const isCustom = !isBuiltin && (!existing || !builtinIds.has(id));
    if (isCustom) {
      if (!baseUrl) throw new Error("自定义服务商需要 Base URL。");
      if (!api) throw new Error("自定义服务商需要选择请求协议。");
      if (!draft.replaceModels || !models.length) throw new Error("自定义服务商至少需要定义一个模型。`models` 是识别新服务商的必填目录。");
    }
    const apiKeyReference = draft.apiKeyReference?.trim();
    if (apiKeyReference && !apiKeyReference.startsWith("$") && !apiKeyReference.startsWith("!")) {
      throw new Error("API Key 引用应使用 $环境变量、${环境变量} 或 !命令；普通密钥请直接填写 API Key 字段。");
    }

    const providerHeaders = mergeMaskedStringRecord(draft.headers, objectValue(existing?.headers));
    const providerCompat = draft.compat && Object.keys(draft.compat).length ? draft.compat : undefined;
    const modelOverrides = draft.modelOverrides && Object.keys(draft.modelOverrides).length ? draft.modelOverrides : undefined;
    const disabled = draft.disabled === true;
    const hasBuiltinOverride = Boolean(
      baseUrl
      || api
      || draft.oauth
      || Object.keys(providerHeaders).length
      || providerCompat
      || draft.authHeader !== undefined
      || draft.replaceModels
      || modelOverrides
      || disabled
      || existing?.disabled === true,
    );

    // A native provider credential save must stay auth.json-only. Provider
    // endpoint/catalog overrides still belong in models.json when the user
    // explicitly configures them under the advanced options.
    if (isBuiltin && !existing && !hasBuiltinOverride) {
      return {
        id,
        provider: apiKeyReference ? { apiKey: apiKeyReference } : {},
        writeModelsConfig: Boolean(apiKeyReference),
      };
    }

    const result: Record<string, unknown> = { ...cloneJson(existing ?? {}) };
    for (const key of ["name", "baseUrl", "api", "oauth", "headers", "compat", "authHeader", "models", "modelOverrides", "disabled"]) delete result[key];
    const set = (key: string, value: unknown): void => {
      if (value !== undefined && value !== "") result[key] = value;
    };
    if (!isBuiltin || existing?.name !== undefined) set("name", draft.name?.trim());
    set("baseUrl", baseUrl);
    set("api", api);
    set("oauth", draft.oauth);
    set("headers", Object.keys(providerHeaders).length ? providerHeaders : undefined);
    set("compat", providerCompat);
    set("authHeader", draft.authHeader);
    if (disabled) result.disabled = true;
    if (apiKeyReference) result.apiKey = apiKeyReference;
    else if (!input.preserveApiKeyReference) delete result.apiKey;
    if (draft.replaceModels) {
      const existingModels = Array.isArray(existing?.models) ? existing.models.filter(isRecord) : [];
      result.models = models.map((model) => modelConfigurationForStorage(model, existingModels.find((item) => optionalString(item, "id") === model.id)));
    }
    set("modelOverrides", modelOverrides);
    return {
      id,
      provider: result,
      writeModelsConfig: !isBuiltin || Boolean(existing) || Object.keys(result).length > 0,
    };
  }

  protected async saveProviderCredential(
    providerId: string,
    input: ModelProviderConfigurationInput,
    modelRuntime: ModelRuntime,
  ): Promise<void> {
    const legacyKey = input.apiKey?.trim();
    if (!input.credential && !legacyKey) return;

    const runtimeProvider = modelRuntime.getProviders().find((provider) => provider.id === providerId);
    if (!runtimeProvider?.auth.apiKey) throw new Error(`服务商 ${providerId} 不支持 API Key 或凭据配置。`);
    const methods = credentialMethodsForProvider(runtimeProvider);
    if (!methods.length) throw new Error(`服务商 ${providerId} 没有可用的 API Key 配置方式。`);

    const credentialInput = input.credential ?? {
      method: methods[0].id,
      values: { key: legacyKey ?? "" },
      preserveFields: [],
    };
    const method = methods.find((item) => item.id === credentialInput.method);
    if (!method) throw new Error(`“${credentialInput.method}”不是 ${runtimeProvider.name} 支持的凭据方式。`);

    const current = readStoredCredential(providerId, join(this.agentDir, "auth.json"));
    const currentApiKey = current?.type === "api_key" ? current : undefined;
    const preserve = new Set(credentialInput.preserveFields);
    const values = Object.fromEntries(Object.entries(credentialInput.values).map(([key, value]) => [key, value.trim()]));
    const knownEnvironmentFields = new Set(methods.flatMap((item) => item.fields.map((field) => field.id)).filter((id) => id !== "key"));
    const env = { ...(currentApiKey?.env ?? {}) };
    for (const field of knownEnvironmentFields) delete env[field];

    let key: string | undefined;
    for (const field of method.fields) {
      const submitted = values[field.id];
      const previous = field.id === "key" ? currentApiKey?.key : currentApiKey?.env?.[field.id];
      const value = submitted || (preserve.has(field.id) ? previous : undefined);
      if (field.required && !value) throw new Error(`${runtimeProvider.name} 的“${field.label}”不能为空。`);
      if (!value) continue;
      if (field.id === "key") key = value;
      else env[field.id] = value;
    }

    if (providerId === "azure-openai-responses" && !env.AZURE_OPENAI_BASE_URL && !env.AZURE_OPENAI_RESOURCE_NAME) {
      throw new Error("Azure OpenAI 需要填写 Endpoint / Base URL 或 Resource Name。两者至少填写一项。");
    }

    const credential: ApiKeyCredential = {
      type: "api_key",
      ...(key ? { key } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
    const authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
    await authStorage.modify(providerId, async () => credential);
    await modelRuntime.refresh({ providers: [providerId], allowNetwork: false });
  }

  /**
   * Apply the small edit an Agent normally has: "add this model" or "make
   * contextWindow 200k". The panel posts a complete form draft; the Agent
   * must not have to repeat every existing model just to change one field.
   */
  async saveModelProviderPatch(input: ModelProviderPatchInput): Promise<ModelProviderSaveResult> {
    const id = assertProviderId(input.id);
    const snapshot = await this.getModelProviderConfiguration();
    const current = snapshot.providers.find((provider) => provider.id === id);
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(input, key);
    const currentModels = current?.models.map((model) => ({ ...model })) ?? [];
    let models: ModelProviderModelConfiguration[] = currentModels;
    if (input.modelsMode === "replace") {
      models = (input.models ?? []).map((model) => ({ ...model }));
    } else if (input.models) {
      const byId = new Map(currentModels.map((model) => [model.id, model]));
      for (const model of input.models) {
        const previous = byId.get(model.id);
        byId.set(model.id, previous ? { ...previous, ...model } : { ...model });
      }
      models = [...byId.values()];
    }
    if (input.removeModels?.length) {
      const removed = new Set(input.removeModels);
      models = models.filter((model) => !removed.has(model.id));
    }

    const provider: ModelProviderConfigurationInput["provider"] = {
      id,
      name: has("name") ? input.name : current?.name,
      baseUrl: has("baseUrl") ? input.baseUrl : current?.baseUrl,
      api: has("api") ? input.api : current?.api,
      oauth: has("oauth") ? input.oauth : current?.oauth,
      headers: has("headers") ? input.headers : current?.headers,
      compat: has("compat") ? input.compat : current?.compat,
      authHeader: has("authHeader") ? input.authHeader : current?.authHeader,
      apiKeyReference: has("apiKeyReference") ? input.apiKeyReference?.trim() || undefined : current?.apiKeyReference,
      disabled: has("disabled") ? input.disabled === true : current?.disabled === true,
      replaceModels: has("replaceModels")
        ? input.replaceModels === true
        : current ? current.replaceModels === true : input.models !== undefined,
      models,
      modelOverrides: has("modelOverrides") ? input.modelOverrides : current?.modelOverrides,
    };

    let credential: ModelProviderConfigurationInput["credential"];
    if (input.credential) {
      const supplied = new Set(Object.keys(input.credential.values));
      const automaticPreserveFields = current?.credential.methods
        .flatMap((method) => method.fields)
        .filter((field) => field.configured && !supplied.has(field.id))
        .map((field) => field.id) ?? [];
      credential = {
        method: input.credential.method,
        values: input.credential.values,
        preserveFields: [...new Set([...automaticPreserveFields, ...(input.credential.preserveFields ?? [])])],
      };
    }

    return this.saveModelProviderConfiguration({
      provider,
      credential,
      apiKey: input.apiKey,
      preserveApiKeyReference: has("preserveApiKeyReference")
        ? input.preserveApiKeyReference === true
        : !has("apiKeyReference"),
    });
  }

  async setModelProviderEnabled(providerId: string, enabled: boolean): Promise<ModelProviderSaveResult> {
    return this.saveModelProviderPatch({ id: providerId, disabled: !enabled });
  }

  async saveModelProviderConfiguration(input: ModelProviderConfigurationInput): Promise<ModelProviderSaveResult> {
    const modelRuntime = await this.ready();
    const privateConfiguration = this.readPrivateModelsConfiguration();
    const builtinIds = new Set<string>([...getBuiltinProviders(), "radius", OPENAI_RESPONSES_WS_PROVIDER_ID]);
    const existing = privateConfiguration.providers[input.provider.id.trim()];
    const next = this.validateModelProviderConfiguration(input, existing, builtinIds);
    if (next.writeModelsConfig) {
      const previous = cloneJson(privateConfiguration);
      const keys = Object.keys(next.provider).filter((key) => key !== "disabled" || next.provider.disabled === true);
      const emptyDisableOnly = builtinIds.has(next.id) && keys.length === 0 && next.provider.disabled !== true;
      if (emptyDisableOnly) delete privateConfiguration.providers[next.id];
      else privateConfiguration.providers[next.id] = next.provider;
      this.writePrivateModelsConfiguration(privateConfiguration);
      try {
        await modelRuntime.refresh({ allowNetwork: false });
        const runtimeError = modelRuntime.getError();
        if (runtimeError?.includes("models.json") || runtimeError?.includes(`Provider \"${next.id}\"`)) throw new Error(runtimeError);
      } catch (error) {
        this.writePrivateModelsConfiguration(previous);
        await modelRuntime.refresh({ allowNetwork: false });
        throw new Error(`无法应用此服务商配置：${errorMessage(error)}`);
      }
    }

    try {
      await this.saveProviderCredential(next.id, input, modelRuntime);
    } catch (error) {
      throw new Error(`服务商配置已保存，但无法保存凭据：${errorMessage(error)}`);
    }

    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    this.refreshSessionModelFromRegistry();
    const saved = await this.getModelProviderConfiguration();
    const provider = saved.providers.find((item) => item.id === next.id);
    if (!provider) throw new Error("配置已刷新，但未能读取刚保存的服务商。");
    return { provider, configuration };
  }

  async removeModelProviderConfiguration(providerId: string): Promise<RuntimeConfiguration> {
    const id = assertProviderId(providerId);
    const privateConfiguration = this.readPrivateModelsConfiguration();
    const existing = privateConfiguration.providers[id];
    const modelRuntime = await this.ready();
    try {
      await modelRuntime.logout(id);
    } catch {
      // A malformed/removed provider may not expose a logout handler; config removal still proceeds.
    }
    if (existing) {
      delete privateConfiguration.providers[id];
      this.writePrivateModelsConfiguration(privateConfiguration);
      await modelRuntime.refresh({ allowNetwork: false });
      const runtimeError = modelRuntime.getError();
      if (runtimeError?.includes("models.json")) throw new Error(`无法重新加载服务商目录：${runtimeError}`);
    } else if (!modelRuntime.hasConfiguredAuth(id)) {
      throw new Error("此服务商没有可移除的配置。");
    }
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    this.refreshSessionModelFromRegistry();
    return configuration;
  }

  async configureModel(input: {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    contextWindow?: number;
    apiKey?: string;
  }): Promise<RuntimeConfiguration> {
    const modelRuntime = await this.ready();
    const model = modelRuntime.getModel(input.provider, input.modelId);
    if (!model) throw new Error(`Unknown model: ${input.provider}/${input.modelId}`);

    if (input.apiKey?.trim()) {
      const key = input.apiKey.trim();
      await modelRuntime.login(input.provider, "api_key", {
        prompt: async () => key,
        notify: () => undefined,
      });
    }
    if (!(await modelRuntime.checkAuth(input.provider))) {
      throw new Error(`No credential is configured for ${input.provider}.`);
    }

    if (input.contextWindow !== undefined) {
      if (!Number.isFinite(input.contextWindow) || input.contextWindow < 1_024) {
        throw new Error("上下文窗口必须是不小于 1024 的数字。");
      }
      this.writeModelRuntimeContextWindow(input.provider, input.modelId, Math.round(input.contextWindow));
    }
    const effectiveModel = this.modelWithRuntimeOptions(model);
    const effectiveThinkingLevel = clampThinkingLevel(effectiveModel, input.thinkingLevel) as ThinkingLevel;
    const settings = SettingsManager.create(this.active?.cwd ?? process.cwd(), this.agentDir);
    settings.setDefaultModelAndProvider(input.provider, input.modelId);
    settings.setDefaultThinkingLevel(effectiveThinkingLevel);
    await settings.flush();

    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  async setSessionModel(input: {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    contextWindow?: number;
  }): Promise<RuntimeConfiguration> {
    const active = this.requireActive();
    if (this.modelTransition) {
      throw new Error("模型正在切换，请稍候。");
    }

    const modelRuntime = await this.ready();
    const model = modelRuntime.getModel(input.provider, input.modelId);
    if (!model) throw new Error(`Unknown model: ${input.provider}/${input.modelId}`);
    if (!(await modelRuntime.checkAuth(input.provider))) {
      throw new Error(`No credential is configured for ${input.provider}.`);
    }
    if (input.contextWindow !== undefined) {
      if (!Number.isFinite(input.contextWindow) || input.contextWindow < 1_024) {
        throw new Error("上下文窗口必须是不小于 1024 的数字。");
      }
      this.writeModelRuntimeContextWindow(input.provider, input.modelId, Math.round(input.contextWindow));
    }

    const effectiveModel = this.modelWithRuntimeOptions(model);
    const effectiveThinkingLevel = clampThinkingLevel(effectiveModel, input.thinkingLevel) as ThinkingLevel;
    const pendingModel: PendingSessionModel = {
      provider: effectiveModel.provider,
      id: effectiveModel.id,
      name: effectiveModel.name || effectiveModel.id,
      reasoning: Boolean(effectiveModel.reasoning),
      thinkingLevel: effectiveThinkingLevel,
    };
    const currentModel = active.session.model;
    const matchesCurrent = Boolean(
      currentModel
      && currentModel.provider === effectiveModel.provider
      && currentModel.id === effectiveModel.id
      && currentModel.contextWindow === effectiveModel.contextWindow
      && active.session.thinkingLevel === effectiveThinkingLevel,
    );
    // A manual compaction is a model request of its own; swapping the model
    // out from under it would move only the half that has not been sent yet.
    const busy = active.session.isStreaming || this.promptStarting || (active.promptQueue?.length ?? 0) > 0 || active.promptDrainInProgress === true || active.compacting === true;

    if (busy) {
      // Never mutate the model object used by an in-flight AgentSession turn.
      // Pi may issue several provider requests inside one turn, so changing
      // session.model here would silently move only the *next* internal call.
      // Keep the latest choice and commit it immediately before the next prompt.
      active.pendingModel = matchesCurrent ? undefined : pendingModel;
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    } else {
      active.pendingModel = undefined;
      const transition = this.commitSessionModel(active, effectiveModel, effectiveThinkingLevel);
      this.modelTransition = transition;
      try {
        await transition;
      } finally {
        if (this.modelTransition === transition) this.modelTransition = undefined;
      }
      // setModel and setThinkingLevel are synchronous from the session's point
      // of view; emit only after both are committed so the UI cannot display a
      // mixed provider/model state.
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    }

    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  private async commitSessionModel(
    active: ActiveSession,
    model: { provider: string; id: string; },
    thinkingLevel: ThinkingLevel,
  ): Promise<void> {
    const modelRuntime = await this.ready();
    const selected = modelRuntime.getModel(model.provider, model.id);
    if (!selected) throw new Error(`Unknown model: ${model.provider}/${model.id}`);
    if (!(await modelRuntime.checkAuth(model.provider))) {
      throw new Error(`No credential is configured for ${model.provider}.`);
    }
    const effectiveModel = this.modelWithRuntimeOptions(selected);
    const effectiveThinkingLevel = clampThinkingLevel(effectiveModel, thinkingLevel) as ThinkingLevel;
    await active.session.setModel(effectiveModel);
    active.session.setThinkingLevel(effectiveThinkingLevel);
    await active.session.settingsManager.flush();
  }

  /** Commit a busy-session selection at the boundary immediately before a prompt. */
  protected async applyPendingSessionModel(active: ActiveSession): Promise<void> {
    const pending = active.pendingModel;
    if (!pending) return;
    await this.commitSessionModel(active, pending, pending.thinkingLevel);
    // A user may select another model while the commit is awaiting provider
    // validation. Preserve that newer selection for the following prompt.
    if (active.pendingModel === pending) active.pendingModel = undefined;
    this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
  }

  async setSessionFast(enabled: boolean): Promise<boolean> {
    const active = this.requireActive();
    if (!active.fastState?.supported) {
      throw new Error("当前模型不支持 Fast / priority 模式。");
    }
    await active.session.prompt(`/fast ${enabled ? "on" : "off"}`);
    if (active.fastState?.enabled !== enabled) {
      throw new Error("Fast 状态没有成功同步到当前会话。");
    }
    return enabled;
  }
}
