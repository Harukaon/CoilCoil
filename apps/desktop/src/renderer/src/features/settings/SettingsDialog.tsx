import { AlertCircle, Cable, Copy, ExternalLink, KeyRound, LoaderCircle, LogOut, Network, Plus, RefreshCw, Search, Settings, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  McpConfigurationSnapshot,
  McpActionResult,
  McpRuntimeStatus,
  McpServerConfiguration,
  McpServerRuntimeStatus,
  RuntimeConfiguration,
  ThinkingLevel,
} from "@suocode/runtime-protocol";
import "./settings.css";

type SettingsSection = "models" | "mcp";
const MASKED_SECRET_VALUE = "••••••";

const mcpStatusLabel: Record<McpServerRuntimeStatus["status"], string> = {
  connected: "已连接",
  "needs-auth": "需要认证",
  failed: "连接失败",
  cached: "已缓存",
  "not connected": "未连接",
};

function mcpStatusClass(status: McpServerRuntimeStatus["status"] | undefined): string {
  return status?.replace(" ", "-") ?? "unknown";
}

function thinkingLevelForModel(
  model: RuntimeConfiguration["models"][number] | undefined,
  requested: ThinkingLevel,
): ThinkingLevel {
  if (!model?.supportedThinkingLevels.length) return "off";
  return model.supportedThinkingLevels.includes(requested) ? requested : model.supportedThinkingLevels[0];
}

function blankMcpServer(): McpServerConfiguration {
  return {
    name: "",
    scope: "global",
    transport: "stdio",
    args: [],
    env: {},
    headers: {},
    lifecycle: "lazy",
    exposeResources: true,
    directTools: false,
    excludeTools: [],
    debug: false,
  };
}

function sensitiveConfigurationKey(key: string): boolean {
  return /(?:authorization|api[-_]?key|token|secret|password|cookie|credential)/i.test(key);
}

function maskedStringMap(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitiveConfigurationKey(key) && entry ? MASKED_SECRET_VALUE : entry]));
}

function parseStringMap(value: string, label: string, original: Record<string, string> = {}): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((item) => typeof item !== "string")) {
    throw new Error(`${label}必须是字符串键值的 JSON 对象。`);
  }
  return Object.fromEntries(Object.entries(parsed as Record<string, string>).map(([key, entry]) => [
    key,
    entry === MASKED_SECRET_VALUE && Object.hasOwn(original, key) ? original[key] : entry,
  ]));
}

function ModelSettings({ configuration, onSaved, runtimeId }: {
  configuration?: RuntimeConfiguration;
  onSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
}): React.JSX.Element {
  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const model of configuration?.models ?? []) map.set(model.provider, model.providerName);
    return [...map].sort((a, b) => {
      const aConfigured = configuration?.configuredProviders.includes(a[0]) ? 1 : 0;
      const bConfigured = configuration?.configuredProviders.includes(b[0]) ? 1 : 0;
      return bConfigured - aConfigured || a[1].localeCompare(b[1]);
    });
  }, [configuration]);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [apiKey, setApiKey] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!configuration) return;
    const nextProvider = configuration.provider || configuration.configuredProviders[0] || providers[0]?.[0] || "";
    const providerModels = configuration.models.filter((model) => model.provider === nextProvider);
    const nextModel = providerModels.find((model) => model.id === configuration.modelId) ?? providerModels[0];
    setProvider(nextProvider);
    setModelId(nextModel?.id || "");
    setThinkingLevel(thinkingLevelForModel(nextModel, configuration.thinkingLevel));
    setApiKey("");
    setModelSearch("");
    setError(undefined);
  }, [configuration, providers]);

  const models = useMemo(() => (configuration?.models ?? []).filter((model) =>
    model.provider === provider && (!modelSearch || `${model.name} ${model.id}`.toLowerCase().includes(modelSearch.toLowerCase())),
  ), [configuration, modelSearch, provider]);
  const selectedModel = configuration?.models.find((model) => model.provider === provider && model.id === modelId);
  const availableThinkingLevels: ThinkingLevel[] = selectedModel?.supportedThinkingLevels?.length ? selectedModel.supportedThinkingLevels : ["off"];
  const configured = configuration?.configuredProviders.includes(provider) ?? false;

  const chooseProvider = (value: string): void => {
    const first = configuration?.models.find((model) => model.provider === value);
    setProvider(value);
    setModelId(first?.id || "");
    setThinkingLevel((current) => thinkingLevelForModel(first, current));
    setModelSearch("");
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!provider || !modelId) return;
    setSaving(true);
    setError(undefined);
    try {
      onSaved(await window.suocode.request<RuntimeConfiguration>({
        type: "configure_model",
        provider,
        modelId,
        thinkingLevel,
        apiKey: apiKey || undefined,
      }, runtimeId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="model-settings-form" onSubmit={(event) => void save(event)}>
      <label>服务商<select value={provider} onChange={(event) => chooseProvider(event.target.value)}>{providers.map(([id, name]) => <option value={id} key={id}>{name}{configuration?.configuredProviders.includes(id) ? " · 已配置" : ""}</option>)}</select></label>
      <label>模型<span className="model-search"><Search size={14} /><input value={modelSearch} placeholder="筛选模型" onChange={(event) => setModelSearch(event.target.value)} /></span><select size={7} value={modelId} onChange={(event) => { const value = event.target.value; setModelId(value); setThinkingLevel((current) => thinkingLevelForModel(configuration?.models.find((item) => item.provider === provider && item.id === value), current)); }}>{models.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.id}{model.reasoning ? " · reasoning" : ""}</option>)}</select></label>
      <div className="settings-grid">
        <label>Thinking<select value={thinkingLevel} disabled={availableThinkingLevels.length === 1} onChange={(event) => setThinkingLevel(event.target.value as ThinkingLevel)}>{availableThinkingLevels.map((level) => <option value={level} key={level}>{level}</option>)}</select></label>
        <label>API 密钥<span className="secret-input"><KeyRound size={14} /><input type="password" value={apiKey} autoComplete="off" placeholder={configured ? "已配置，留空可保留" : "粘贴服务商 API 密钥"} onChange={(event) => setApiKey(event.target.value)} /></span></label>
      </div>
      {error ? <div className="settings-error"><AlertCircle size={14} />{error}</div> : null}
      <footer><span>{configured ? "服务商凭据可用" : "首次发送消息前需要配置凭据。"}</span><button className="primary-button" type="submit" disabled={saving || !provider || !modelId}>{saving ? <LoaderCircle className="spin" size={15} /> : null}保存模型设置</button></footer>
    </form>
  );
}

function McpSettings({ runtimeId, cwd }: { runtimeId?: string; cwd?: string }): React.JSX.Element {
  const [configuration, setConfiguration] = useState<McpConfigurationSnapshot>();
  const [selectedName, setSelectedName] = useState<string>();
  const [draft, setDraft] = useState<McpServerConfiguration>(blankMcpServer);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("{}");
  const [headersText, setHeadersText] = useState("{}");
  const [originalEnv, setOriginalEnv] = useState<Record<string, string>>({});
  const [originalHeaders, setOriginalHeaders] = useState<Record<string, string>>({});
  const [directToolsText, setDirectToolsText] = useState("");
  const [excludeToolsText, setExcludeToolsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<McpRuntimeStatus>();
  const [actionMessage, setActionMessage] = useState<string>();
  const [authorizationUrl, setAuthorizationUrl] = useState<string>();
  const [authInput, setAuthInput] = useState("");
  const [error, setError] = useState<string>();
  const editVersionRef = useRef(0);
  const loadVersionRef = useRef(0);

  const selectServer = (server?: McpServerConfiguration, userInitiated = false): void => {
    if (userInitiated) editVersionRef.current += 1;
    const next = server ? { ...server, args: [...server.args], env: { ...server.env }, headers: { ...server.headers } } : blankMcpServer();
    setSelectedName(server?.name);
    setDraft(next);
    setArgsText(next.args.join("\n"));
    setOriginalEnv({ ...next.env });
    setOriginalHeaders({ ...next.headers });
    setEnvText(JSON.stringify(maskedStringMap(next.env), null, 2));
    setHeadersText(JSON.stringify(maskedStringMap(next.headers), null, 2));
    setDirectToolsText(Array.isArray(next.directTools) ? next.directTools.join("\n") : "");
    setExcludeToolsText(next.excludeTools.join("\n"));
    setActionMessage(undefined);
    setAuthorizationUrl(undefined);
    setAuthInput("");
    setError(undefined);
  };

  const loadStatus = async (surfaceError = false): Promise<void> => {
    if (!runtimeId) {
      setRuntimeStatus(undefined);
      if (surfaceError) setError("打开一个会话后即可查看 MCP 连接状态。");
      return;
    }
    setStatusLoading(true);
    if (surfaceError) setError(undefined);
    try {
      setRuntimeStatus(await window.suocode.request<McpRuntimeStatus>({ type: "get_mcp_status" }, runtimeId));
    } catch (caught) {
      setRuntimeStatus(undefined);
      if (surfaceError) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStatusLoading(false);
    }
  };

  const load = async (): Promise<void> => {
    const loadVersion = ++loadVersionRef.current;
    const editVersion = editVersionRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.suocode.request<McpConfigurationSnapshot>({ type: "get_mcp_configuration", cwd }, runtimeId);
      if (loadVersion !== loadVersionRef.current) return;
      setConfiguration(next);
      if (editVersion === editVersionRef.current) {
        const selected = next.servers.find((server) => server.name === selectedName) ?? next.servers[0];
        selectServer(selected);
      }
    } catch (caught) {
      if (loadVersion !== loadVersionRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (loadVersion === loadVersionRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void loadStatus();
  }, [cwd, runtimeId]);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const server: McpServerConfiguration = {
        ...draft,
        name: draft.name.trim(),
        command: draft.command?.trim() || undefined,
        url: draft.url?.trim() || undefined,
        cwd: draft.cwd?.trim() || undefined,
        args: argsText.split("\n").map((item) => item.trim()).filter(Boolean),
        env: parseStringMap(envText, "环境变量", originalEnv),
        headers: parseStringMap(headersText, "请求头", originalHeaders),
        bearerTokenEnv: draft.bearerTokenEnv?.trim() || undefined,
        idleTimeout: draft.idleTimeout === undefined || Number.isNaN(draft.idleTimeout) ? undefined : draft.idleTimeout,
        requestTimeoutMs: draft.requestTimeoutMs === undefined || Number.isNaN(draft.requestTimeoutMs) ? undefined : draft.requestTimeoutMs,
        directTools: directToolsText.trim() ? directToolsText.split("\n").map((item) => item.trim()).filter(Boolean) : draft.directTools === true,
        excludeTools: excludeToolsText.split("\n").map((item) => item.trim()).filter(Boolean),
      };
      const next = await window.suocode.request<McpConfigurationSnapshot>({ type: "save_mcp_server", server, previousName: selectedName, cwd }, runtimeId);
      setConfiguration(next);
      selectServer(next.servers.find((item) => item.name === server.name));
      void loadStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    const ownedSource = draft.source === configuration?.configPath || draft.source === configuration?.projectConfigPath;
    if (!selectedName || !ownedSource) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await window.suocode.request<McpConfigurationSnapshot>({ type: "remove_mcp_server", name: selectedName, scope: draft.scope, cwd }, runtimeId);
      setConfiguration(next);
      selectServer(next.servers[0]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const enableDetectedImports = async (): Promise<void> => {
    const imports = configuration?.imports.filter((item) => !item.enabled).map((item) => item.kind) ?? [];
    if (!imports.length) return;
    setSaving(true);
    setError(undefined);
    try {
      setConfiguration(await window.suocode.request<McpConfigurationSnapshot>({ type: "enable_mcp_imports", imports, cwd }, runtimeId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const applyActionResult = (result: McpActionResult): void => {
    if (result.status) setRuntimeStatus(result.status);
    setActionMessage(result.text || "MCP 扩展已完成操作。");
    const detailsError = typeof result.details?.error === "string" ? result.details.error : undefined;
    if (detailsError) setError(typeof result.details?.message === "string" ? result.details.message : detailsError);
  };

  const connect = async (): Promise<void> => {
    if (!selectedName) return;
    setActionBusy(true);
    setError(undefined);
    setActionMessage(undefined);
    try {
      applyActionResult(await window.suocode.request<McpActionResult>({ type: "connect_mcp_server", name: selectedName }, runtimeId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const startAuth = async (): Promise<void> => {
    if (!selectedName) return;
    setActionBusy(true);
    setError(undefined);
    setActionMessage(undefined);
    try {
      const result = await window.suocode.request<McpActionResult>({ type: "start_mcp_auth", name: selectedName }, runtimeId);
      applyActionResult(result);
      const url = typeof result.details?.authorizationUrl === "string" ? result.details.authorizationUrl : undefined;
      setAuthorizationUrl(url);
      if (url) await window.suocode.openExternal(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const completeAuth = async (): Promise<void> => {
    if (!selectedName || !authInput.trim()) return;
    setActionBusy(true);
    setError(undefined);
    setActionMessage(undefined);
    try {
      const result = await window.suocode.request<McpActionResult>({ type: "complete_mcp_auth", name: selectedName, input: authInput }, runtimeId);
      applyActionResult(result);
      if (!result.details?.error) {
        setAuthorizationUrl(undefined);
        setAuthInput("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    if (!selectedName) return;
    setActionBusy(true);
    setError(undefined);
    setActionMessage(undefined);
    try {
      applyActionResult(await window.suocode.request<McpActionResult>({ type: "logout_mcp_server", name: selectedName }, runtimeId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const selectedStatus = runtimeStatus?.servers.find((server) => server.name === selectedName);
  const supportsAuth = draft.transport === "http" && draft.auth !== false;

  return (
    <div className="mcp-settings">
      <aside className="mcp-server-list">
        <div className="mcp-list-toolbar"><button className="mcp-add-button" type="button" disabled={loading} onClick={() => selectServer(undefined, true)}><Plus size={13} />添加服务器</button><button className="mcp-refresh-button" type="button" aria-label="刷新 MCP 状态" disabled={statusLoading || !runtimeId} onClick={() => void loadStatus(true)}>{statusLoading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button></div>
        {runtimeStatus ? <p className="mcp-status-summary">{runtimeStatus.state === "initializing" ? "MCP 扩展初始化中" : runtimeStatus.state === "unavailable" ? "MCP 扩展暂不可用" : `${runtimeStatus.connectedCount} 个已连接 · ${runtimeStatus.totalTools} 个工具`}</p> : null}
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={15} />加载 MCP 配置…</div> : configuration?.servers.map((server) => { const status = runtimeStatus?.servers.find((item) => item.name === server.name); return <button className={server.name === selectedName ? "active" : ""} type="button" key={server.name} onClick={() => selectServer(server, true)}><span className="mcp-server-title"><i className={`mcp-status-dot ${mcpStatusClass(status?.status)}`} /><strong>{server.name}</strong>{status?.toolCount ? <em>{status.toolCount}</em> : null}</span><small>{status ? mcpStatusLabel[status.status] : server.scope === "project" ? "当前项目" : "全局"} · {server.transport === "http" ? server.url : server.command}</small></button>; })}
        {!loading && !configuration?.servers.length ? <p>尚未配置 MCP 服务器。</p> : null}
      </aside>
      <section className="mcp-editor">
        <form onSubmit={(event) => void save(event)}>
          <div className="mcp-editor-heading"><div><strong>{selectedName ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</strong><small>连接、认证与工具发现均由内置 pi-mcp-adapter 执行。</small></div><span className="mcp-editor-actions">{selectedName ? <button className="icon-button" type="button" aria-label="连接 MCP 服务器" disabled={actionBusy || !runtimeId} onClick={() => void connect()}>{actionBusy ? <LoaderCircle className="spin" size={14} /> : <Cable size={14} />}</button> : null}{supportsAuth && selectedName ? <button className="icon-button" type="button" aria-label="认证 MCP 服务器" disabled={actionBusy || !runtimeId} onClick={() => void startAuth()}><ExternalLink size={14} /></button> : null}{selectedName ? <button className="icon-button" type="button" aria-label="复制 MCP 服务器" onClick={() => { const copy = { ...draft, name: `${draft.name}-copy`, source: undefined, sourceKind: undefined }; editVersionRef.current += 1; setSelectedName(undefined); setDraft(copy); }}><Copy size={14} /></button> : null}{selectedName && ((draft.scope === "global" && draft.source === configuration?.configPath) || (draft.scope === "project" && draft.source === configuration?.projectConfigPath)) ? <button className="danger-icon-button" type="button" aria-label="移除 MCP 服务器" onClick={() => void remove()}><Trash2 size={14} /></button> : null}</span></div>
          {selectedName ? <div className="mcp-runtime-card"><span><i className={`mcp-status-dot ${mcpStatusClass(selectedStatus?.status)}`} /><strong>{runtimeStatus?.state === "initializing" ? "初始化中" : runtimeStatus?.state === "unavailable" ? "暂不可用" : selectedStatus ? mcpStatusLabel[selectedStatus.status] : runtimeId ? "状态未知" : "打开会话后可连接"}</strong>{selectedStatus?.toolCount ? <small>{selectedStatus.toolCount} 个工具</small> : null}</span><button type="button" disabled={actionBusy || !runtimeId || runtimeStatus?.state === "initializing"} onClick={() => void connect()}><Cable size={13} />{selectedStatus?.status === "connected" ? "重新连接" : "连接"}</button>{supportsAuth ? <><button type="button" disabled={actionBusy || !runtimeId || runtimeStatus?.state === "initializing"} onClick={() => void startAuth()}><ExternalLink size={13} />认证</button><button type="button" disabled={actionBusy || !runtimeId || runtimeStatus?.state === "initializing"} onClick={() => void logout()}><LogOut size={13} />登出</button></> : null}</div> : null}
          {runtimeStatus?.diagnostic ? <p className="mcp-source-note">{runtimeStatus.diagnostic}</p> : null}
          <div className="settings-grid"><label>名称<input value={draft.name} placeholder="例如 github" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label><label>作用域<select value={draft.scope} disabled={!cwd} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as McpServerConfiguration["scope"] }))}><option value="global">全局</option><option value="project">当前项目</option></select></label></div>
          <label>连接方式<select value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value as McpServerConfiguration["transport"] }))}><option value="stdio">stdio 命令</option><option value="http">HTTP</option></select></label>
          {draft.transport === "stdio" ? <><label>启动命令<input value={draft.command ?? ""} placeholder="npx" onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} /></label><label>参数（每行一个）<textarea value={argsText} placeholder="-y&#10;@modelcontextprotocol/server-filesystem" onChange={(event) => setArgsText(event.target.value)} /></label><div className="settings-grid"><label>工作目录<input value={draft.cwd ?? ""} placeholder="可选" onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} /></label><label>环境变量 JSON<textarea value={envText} onChange={(event) => setEnvText(event.target.value)} /></label></div></> : <><label>服务器地址<input value={draft.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} /></label><div className="settings-grid"><label>认证<select value={String(draft.auth ?? "auto")} onChange={(event) => setDraft((current) => ({ ...current, auth: event.target.value === "auto" ? undefined : event.target.value === "false" ? false : event.target.value as "oauth" | "bearer" }))}><option value="auto">自动检测</option><option value="oauth">OAuth</option><option value="bearer">Bearer</option><option value="false">不认证</option></select></label><label>Bearer 环境变量<input value={draft.bearerTokenEnv ?? ""} placeholder="例如 GITHUB_TOKEN" onChange={(event) => setDraft((current) => ({ ...current, bearerTokenEnv: event.target.value }))} /></label></div><label>请求头 JSON<textarea value={headersText} onChange={(event) => setHeadersText(event.target.value)} /></label></>}
          <div className="settings-grid"><label>生命周期<select value={draft.lifecycle} onChange={(event) => setDraft((current) => ({ ...current, lifecycle: event.target.value as McpServerConfiguration["lifecycle"] }))}><option value="lazy">按需连接</option><option value="keep-alive">保持连接</option><option value="eager">启动时连接</option></select></label><label>空闲超时（分钟）<input type="number" min="0" value={draft.idleTimeout ?? ""} placeholder="使用扩展默认值" onChange={(event) => setDraft((current) => ({ ...current, idleTimeout: event.target.value ? Number(event.target.value) : undefined }))} /></label></div>
          <div className="settings-grid"><label>请求超时（毫秒）<input type="number" min="0" value={draft.requestTimeoutMs ?? ""} placeholder="使用扩展默认值" onChange={(event) => setDraft((current) => ({ ...current, requestTimeoutMs: event.target.value ? Number(event.target.value) : undefined }))} /></label><label className="checkbox-setting"><input type="checkbox" checked={draft.debug} onChange={(event) => setDraft((current) => ({ ...current, debug: event.target.checked }))} />显示服务器调试输出</label></div>
          <div className="settings-grid"><label>直接注册的工具（每行一个）<textarea value={directToolsText} placeholder="留空时使用下面的全部开关" onChange={(event) => setDirectToolsText(event.target.value)} /></label><label>排除工具（每行一个）<textarea value={excludeToolsText} onChange={(event) => setExcludeToolsText(event.target.value)} /></label></div>
          <div className="settings-grid"><label className="checkbox-setting"><input type="checkbox" checked={draft.directTools === true} disabled={Boolean(directToolsText.trim())} onChange={(event) => setDraft((current) => ({ ...current, directTools: event.target.checked }))} />直接注册全部服务器工具</label><label className="checkbox-setting"><input type="checkbox" checked={draft.exposeResources} onChange={(event) => setDraft((current) => ({ ...current, exposeResources: event.target.checked }))} />向 Agent 暴露资源</label></div>
          {draft.source && draft.source !== configuration?.configPath ? <p className="mcp-source-note">当前配置来自 {draft.source}。保存后会在 SuoCode 私有配置中创建同名覆盖，不会修改外部应用。</p> : null}
          {authorizationUrl ? <div className="mcp-auth-panel"><strong>完成 OAuth 认证</strong><p>浏览器已打开扩展生成的授权地址。完成授权后，粘贴回调地址或授权码。</p><button type="button" onClick={() => void window.suocode.openExternal(authorizationUrl)}><ExternalLink size={13} />重新打开授权页</button><textarea value={authInput} placeholder="粘贴回调地址或授权码" onChange={(event) => setAuthInput(event.target.value)} /><button className="primary-button" type="button" disabled={actionBusy || !authInput.trim()} onClick={() => void completeAuth()}>完成认证</button></div> : null}
          {actionMessage ? <div className="mcp-action-message">{actionMessage}</div> : null}
          {error ? <div className="settings-error"><AlertCircle size={14} />{error}</div> : null}
          <footer><span>{configuration?.configPath}</span><button className="primary-button" type="submit" disabled={saving || !draft.name.trim()}>{saving ? <LoaderCircle className="spin" size={15} /> : null}保存 MCP</button></footer>
        </form>
        {configuration?.imports.length ? <div className="mcp-imports"><div><strong>检测到的兼容配置</strong><small>由 pi-mcp-adapter 负责解析 Cursor、Claude、Codex 等现有配置。</small></div><div className="mcp-import-list">{configuration.imports.map((item) => <span className={item.enabled ? "enabled" : ""} key={`${item.kind}-${item.path}`}><b>{item.kind}</b><small>{item.serverCount} 个服务器</small></span>)}</div>{configuration.imports.some((item) => !item.enabled) ? <button type="button" disabled={saving} onClick={() => void enableDetectedImports()}>导入检测到的配置</button> : null}</div> : null}
      </section>
    </div>
  );
}

export function SettingsDialog({ configuration, open, onClose, onSaved, runtimeId, cwd }: {
  configuration?: RuntimeConfiguration;
  open: boolean;
  onClose: () => void;
  onSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
  cwd?: string;
}): React.JSX.Element | null {
  const [section, setSection] = useState<SettingsSection>("models");
  useEffect(() => { if (!open) setSection("models"); }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><span className="settings-icon">{section === "models" ? <Settings size={16} /> : <Network size={16} />}</span><div><h2 id="settings-title">设置</h2><p>模型凭据和 MCP 配置均保存在 SuoCode 的私有运行时中。</p></div></div><button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><X size={17} /></button></header>
        <nav className="settings-tabs"><button className={section === "models" ? "active" : ""} type="button" onClick={() => setSection("models")}><Settings size={14} />模型与服务商</button><button className={section === "mcp" ? "active" : ""} type="button" onClick={() => setSection("mcp")}><Network size={14} />MCP</button></nav>
        {section === "models" ? <ModelSettings configuration={configuration} onSaved={onSaved} runtimeId={runtimeId} /> : <McpSettings runtimeId={runtimeId} cwd={cwd} />}
      </section>
    </div>
  );
}
