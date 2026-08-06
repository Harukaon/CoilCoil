import { AlertCircle, KeyRound, LoaderCircle, Network, Plus, Search, Settings, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  McpConfigurationSnapshot,
  McpServerConfiguration,
  RuntimeConfiguration,
  ThinkingLevel,
} from "@suocode/runtime-protocol";

type SettingsSection = "models" | "mcp";

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
    transport: "stdio",
    args: [],
    env: {},
    headers: {},
    lifecycle: "lazy",
    directTools: false,
  };
}

function parseStringMap(value: string, label: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((item) => typeof item !== "string")) {
    throw new Error(`${label}必须是字符串键值的 JSON 对象。`);
  }
  return parsed as Record<string, string>;
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const selectServer = (server?: McpServerConfiguration): void => {
    const next = server ? { ...server, args: [...server.args], env: { ...server.env }, headers: { ...server.headers } } : blankMcpServer();
    setSelectedName(server?.name);
    setDraft(next);
    setArgsText(next.args.join("\n"));
    setEnvText(JSON.stringify(next.env, null, 2));
    setHeadersText(JSON.stringify(next.headers, null, 2));
    setError(undefined);
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.suocode.request<McpConfigurationSnapshot>({ type: "get_mcp_configuration", cwd }, runtimeId);
      setConfiguration(next);
      const selected = next.servers.find((server) => server.name === selectedName) ?? next.servers[0];
      selectServer(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [cwd, runtimeId]);

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
        env: parseStringMap(envText, "环境变量"),
        headers: parseStringMap(headersText, "请求头"),
      };
      const next = await window.suocode.request<McpConfigurationSnapshot>({ type: "save_mcp_server", server, previousName: selectedName, cwd }, runtimeId);
      setConfiguration(next);
      selectServer(next.servers.find((item) => item.name === server.name));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selectedName || draft.sourceKind !== "user" || draft.source !== configuration?.configPath) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await window.suocode.request<McpConfigurationSnapshot>({ type: "remove_mcp_server", name: selectedName, cwd }, runtimeId);
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

  return (
    <div className="mcp-settings">
      <aside className="mcp-server-list">
        <button className="mcp-add-button" type="button" onClick={() => selectServer()}><Plus size={13} />添加服务器</button>
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={15} />加载 MCP 配置…</div> : configuration?.servers.map((server) => <button className={server.name === selectedName ? "active" : ""} type="button" key={server.name} onClick={() => selectServer(server)}><strong>{server.name}</strong><small>{server.transport === "http" ? server.url : server.command}</small></button>)}
        {!loading && !configuration?.servers.length ? <p>尚未配置 MCP 服务器。</p> : null}
      </aside>
      <section className="mcp-editor">
        <form onSubmit={(event) => void save(event)}>
          <div className="mcp-editor-heading"><div><strong>{selectedName ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</strong><small>配置由内置的 pi-mcp-adapter 读取并执行。</small></div>{selectedName && draft.sourceKind === "user" && draft.source === configuration?.configPath ? <button className="danger-icon-button" type="button" aria-label="移除 MCP 服务器" onClick={() => void remove()}><Trash2 size={14} /></button> : null}</div>
          <div className="settings-grid"><label>名称<input value={draft.name} placeholder="例如 github" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label><label>连接方式<select value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value as McpServerConfiguration["transport"] }))}><option value="stdio">stdio 命令</option><option value="http">HTTP</option></select></label></div>
          {draft.transport === "stdio" ? <><label>启动命令<input value={draft.command ?? ""} placeholder="npx" onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} /></label><label>参数（每行一个）<textarea value={argsText} placeholder="-y&#10;@modelcontextprotocol/server-filesystem" onChange={(event) => setArgsText(event.target.value)} /></label><div className="settings-grid"><label>工作目录<input value={draft.cwd ?? ""} placeholder="可选" onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} /></label><label>环境变量 JSON<textarea value={envText} onChange={(event) => setEnvText(event.target.value)} /></label></div></> : <><label>服务器地址<input value={draft.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} /></label><div className="settings-grid"><label>认证<select value={String(draft.auth ?? "auto")} onChange={(event) => setDraft((current) => ({ ...current, auth: event.target.value === "auto" ? undefined : event.target.value === "false" ? false : event.target.value as "oauth" | "bearer" }))}><option value="auto">自动检测</option><option value="oauth">OAuth</option><option value="bearer">Bearer</option><option value="false">不认证</option></select></label><label>请求头 JSON<textarea value={headersText} onChange={(event) => setHeadersText(event.target.value)} /></label></div></>}
          <div className="settings-grid"><label>生命周期<select value={draft.lifecycle} onChange={(event) => setDraft((current) => ({ ...current, lifecycle: event.target.value as McpServerConfiguration["lifecycle"] }))}><option value="lazy">按需连接</option><option value="keep-alive">保持连接</option><option value="eager">启动时连接</option></select></label><label className="checkbox-setting"><input type="checkbox" checked={draft.directTools} onChange={(event) => setDraft((current) => ({ ...current, directTools: event.target.checked }))} />直接注册服务器工具</label></div>
          {draft.source && draft.source !== configuration?.configPath ? <p className="mcp-source-note">当前配置来自 {draft.source}。保存后会在 SuoCode 私有配置中创建同名覆盖，不会修改外部应用。</p> : null}
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
