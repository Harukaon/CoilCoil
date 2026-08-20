import {
  type AuthEvent,
  type AuthPrompt,
} from "@earendil-works/pi-ai";
import {
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import {
  type FetchProviderModelsInput,
  type FetchProviderModelsResult,
  type ModelProviderAuthPrompt,
  type ModelProviderAuthState,
  type RuntimeConfiguration,
  type TestProviderConnectionInput,
  type TestProviderConnectionResult,
} from "@coilcoil/runtime-protocol";
import {
  randomUUID,
} from "node:crypto";
import {
  join,
} from "node:path";
import {
  ProviderAuthFlow,
  assertOptionalUrl,
  isOpenAiCompatibleProviderApi,
  joinProviderUrl,
  modelListAuthHeaderVariants,
  modelListUrlCandidates,
  parseUpstreamModelList,
  truncateDetail,
} from "./provider-helpers.js";
import { RuntimeProviderSettings } from "./runtime-provider-settings.js";
import {
  errorDetail,
  errorMessage,
} from "./runtime-utils.js";

export abstract class RuntimeProviderAuth extends RuntimeProviderSettings {
  protected publishProviderAuth(flow: ProviderAuthFlow): void {
    this.emitEvent({
      type: "model_provider_auth_updated",
      state: {
        ...flow.state,
        prompt: flow.state.prompt
          ? flow.state.prompt.type === "select"
            ? { ...flow.state.prompt, options: flow.state.prompt.options.map((option) => ({ ...option })) }
            : { ...flow.state.prompt }
          : undefined,
        authUrl: flow.state.authUrl ? { ...flow.state.authUrl } : undefined,
        deviceCode: flow.state.deviceCode ? { ...flow.state.deviceCode } : undefined,
        links: flow.state.links?.map((link) => ({ ...link })),
      },
    });
  }

  protected updateProviderAuth(flow: ProviderAuthFlow, patch: Partial<ModelProviderAuthState>): void {
    flow.state = { ...flow.state, ...patch };
    this.publishProviderAuth(flow);
  }

  protected clearProviderAuthPrompt(flow: ProviderAuthFlow): ProviderAuthFlow["pendingPrompt"] {
    const pending = flow.pendingPrompt;
    if (!pending) return undefined;
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    flow.pendingPrompt = undefined;
    return pending;
  }

  protected waitForProviderAuthPrompt(flow: ProviderAuthFlow, prompt: AuthPrompt): Promise<string> {
    if (flow.controller.signal.aborted) return Promise.reject(new Error("订阅登录已取消。"));
    if (flow.pendingPrompt) return Promise.reject(new Error("订阅登录正在等待上一个输入。"));
    const id = randomUUID();
    const projected: ModelProviderAuthPrompt = prompt.type === "select"
      ? {
        id,
        type: "select",
        message: prompt.message,
        options: prompt.options.map((option) => ({ ...option })),
      }
      : {
        id,
        type: prompt.type,
        message: prompt.message,
        placeholder: prompt.placeholder,
      };
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        if (flow.pendingPrompt?.id !== id) return;
        flow.pendingPrompt = undefined;
        reject(new Error("当前授权输入已失效。"));
      };
      flow.pendingPrompt = { id, resolve, reject, signal: prompt.signal, onAbort };
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      this.updateProviderAuth(flow, {
        status: "waiting_for_user",
        message: prompt.message,
        prompt: projected,
        error: undefined,
      });
    });
  }

  protected handleProviderAuthNotification(flow: ProviderAuthFlow, event: AuthEvent): void {
    if (flow.controller.signal.aborted) return;
    switch (event.type) {
      case "auth_url":
        this.updateProviderAuth(flow, {
          status: flow.pendingPrompt ? "waiting_for_user" : "authorizing",
          message: event.instructions ?? "请在浏览器中完成订阅登录。",
          authUrl: { url: event.url, instructions: event.instructions },
          error: undefined,
        });
        break;
      case "device_code":
        this.updateProviderAuth(flow, {
          status: "authorizing",
          message: "请在浏览器中输入设备验证码，CoilCoil 会自动等待授权完成。",
          deviceCode: {
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            expiresInSeconds: event.expiresInSeconds,
          },
          error: undefined,
        });
        break;
      case "info":
        this.updateProviderAuth(flow, {
          status: flow.pendingPrompt ? "waiting_for_user" : "authorizing",
          message: event.message,
          links: event.links?.map((link) => ({ ...link })),
          error: undefined,
        });
        break;
      case "progress":
        this.updateProviderAuth(flow, {
          status: flow.pendingPrompt ? "waiting_for_user" : "authorizing",
          message: event.message,
          error: undefined,
        });
        break;
    }
  }

  async startModelProviderOAuth(providerId: string): Promise<ModelProviderAuthState> {
    const modelRuntime = await this.ready();
    const provider = modelRuntime.getProvider(providerId);
    const oauth = provider?.auth.oauth;
    if (!provider || !oauth) throw new Error("此服务商不支持订阅登录。");
    const existing = [...this.providerAuthFlows.values()].find((flow) => flow.state.provider === providerId);
    if (existing) return existing.state;

    const flow: ProviderAuthFlow = {
      controller: new AbortController(),
      state: {
        flowId: randomUUID(),
        provider: providerId,
        providerName: provider.name,
        loginLabel: oauth.loginLabel ?? oauth.name,
        status: "starting",
        message: "正在准备订阅登录…",
      },
    };
    this.providerAuthFlows.set(flow.state.flowId, flow);
    this.publishProviderAuth(flow);

    void modelRuntime.login(providerId, "oauth", {
      signal: flow.controller.signal,
      prompt: (prompt) => this.waitForProviderAuthPrompt(flow, prompt),
      notify: (event) => this.handleProviderAuthNotification(flow, event),
    }).then(async () => {
      if (this.providerAuthFlows.get(flow.state.flowId) !== flow) return;
      this.clearProviderAuthPrompt(flow);
      this.updateProviderAuth(flow, {
        status: "succeeded",
        message: `${flow.state.providerName} 订阅登录成功。`,
        prompt: undefined,
        error: undefined,
      });
      this.providerAuthFlows.delete(flow.state.flowId);
      try {
        const configuration = await this.getConfiguration();
        this.emitEvent({ type: "configuration_updated", configuration });
        this.refreshSessionModelFromRegistry();
      } catch (error) {
        this.emitEvent({ type: "runtime_error", message: "订阅登录已保存，但模型目录刷新失败。", detail: errorDetail(error) });
      }
    }).catch((error) => {
      if (this.providerAuthFlows.get(flow.state.flowId) !== flow) return;
      this.clearProviderAuthPrompt(flow);
      if (flow.controller.signal.aborted) {
        this.updateProviderAuth(flow, {
          status: "cancelled",
          message: "订阅登录已取消。",
          prompt: undefined,
          error: undefined,
        });
      } else {
        this.updateProviderAuth(flow, {
          status: "failed",
          message: "订阅登录失败。",
          prompt: undefined,
          error: errorMessage(error),
        });
      }
      this.providerAuthFlows.delete(flow.state.flowId);
    });
    return { ...flow.state };
  }

  async respondModelProviderOAuth(flowId: string, promptId: string, value: string): Promise<void> {
    const flow = this.providerAuthFlows.get(flowId);
    if (!flow) throw new Error("这次订阅登录已经结束，请重新发起登录。");
    const pending = flow.pendingPrompt;
    if (!pending || pending.id !== promptId) throw new Error("授权步骤已经变化，请按当前界面继续。");
    this.clearProviderAuthPrompt(flow);
    this.updateProviderAuth(flow, {
      status: "authorizing",
      message: "正在验证授权信息…",
      prompt: undefined,
      error: undefined,
    });
    pending.resolve(value);
  }

  async cancelModelProviderOAuth(flowId: string): Promise<void> {
    const flow = this.providerAuthFlows.get(flowId);
    if (!flow) return;
    const pending = this.clearProviderAuthPrompt(flow);
    flow.controller.abort();
    pending?.reject(new Error("订阅登录已取消。"));
    this.updateProviderAuth(flow, {
      status: "cancelled",
      message: "订阅登录已取消。",
      prompt: undefined,
      error: undefined,
    });
    this.providerAuthFlows.delete(flowId);
  }

  async removeProviderAuth(provider: string): Promise<RuntimeConfiguration> {
    const modelRuntime = await this.ready();
    await modelRuntime.logout(provider);
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    this.refreshSessionModelFromRegistry();
    return configuration;
  }

  async fetchProviderModels(input: FetchProviderModelsInput): Promise<FetchProviderModelsResult> {
    const baseUrl = assertOptionalUrl(input.baseUrl, "Base URL");
    if (!baseUrl) throw new Error("拉取模型列表需要 Base URL。");
    // Model list is almost always OpenAI-compatible `/models`, independent of the chat protocol
    // (Anthropic / Gemini / etc.). Try with and without `/v1` so users do not need to flip API + URL.
    const apiKey = await this.resolveProviderApiKey(input.provider, input.apiKey);
    const baseHeaders: Record<string, string> = {
      Accept: "application/json",
      ...(input.headers ?? {}),
    };
    const headerVariants = modelListAuthHeaderVariants(baseHeaders, apiKey, input.api);
    const urls = modelListUrlCandidates(baseUrl);
    const errors: string[] = [];

    for (const url of urls) {
      for (const headers of headerVariants) {
        try {
          const response = await fetch(url, { method: "GET", headers });
          const text = await response.text();
          if (!response.ok) {
            errors.push(`${url} → HTTP ${response.status}: ${truncateDetail(text)}`);
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            errors.push(`${url} → 返回的不是 JSON：${truncateDetail(text)}`);
            continue;
          }
          const models = parseUpstreamModelList(parsed);
          if (!models.length) {
            errors.push(`${url} → 未返回可用模型`);
            continue;
          }
          return { models };
        } catch (error) {
          errors.push(`${url} → ${errorMessage(error)}`);
        }
      }
    }

    const detail = errors.at(-1) ?? "未知错误";
    throw new Error(`拉取模型失败：已自动尝试有/无 /v1 的地址。最后一次：${detail}`);
  }

  async testProviderConnection(input: TestProviderConnectionInput): Promise<TestProviderConnectionResult> {
    const baseUrl = assertOptionalUrl(input.baseUrl, "Base URL");
    if (!baseUrl) throw new Error("测试连接需要 Base URL。");
    const api = input.api.trim();
    if (!isOpenAiCompatibleProviderApi(api)) {
      return { ok: false, message: "当前协议暂不支持一键测试。", detail: "请改用 OpenAI Chat Completions 或 OpenAI Responses。" };
    }
    const apiKey = await this.resolveProviderApiKey(input.provider, input.apiKey);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(input.headers ?? {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    const modelId = input.modelId?.trim();
    if (!modelId) return { ok: false, message: "请先选择要测试的模型。" };
    try {
      if (api === "openai-responses") {
        const url = joinProviderUrl(baseUrl, "responses");
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelId,
            input: "Hello",
            max_output_tokens: 16,
          }),
        });
        const text = await response.text();
        if (!response.ok) return { ok: false, message: `测试失败（HTTP ${response.status}）`, detail: truncateDetail(text) };
        return { ok: true, message: "已收到 Responses 回复。" };
      }
      const url = joinProviderUrl(baseUrl, "chat/completions");
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 16,
        }),
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, message: `测试失败（HTTP ${response.status}）`, detail: truncateDetail(text) };
      return { ok: true, message: "已收到 Chat Completions 回复。" };
    } catch (error) {
      return { ok: false, message: "测试请求失败", detail: errorMessage(error) };
    }
  }

  protected async resolveProviderApiKey(providerId: string | undefined, submitted?: string): Promise<string | undefined> {
    const trimmed = submitted?.trim();
    if (trimmed) return trimmed;
    if (!providerId?.trim()) return undefined;
    const stored = readStoredCredential(providerId.trim(), join(this.agentDir, "auth.json"));
    if (stored?.type === "api_key" && stored.key) return stored.key;
    return undefined;
  }
}
