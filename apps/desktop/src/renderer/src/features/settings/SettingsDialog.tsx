import { AlertCircle, ArrowLeft, Cable, ExternalLink, LoaderCircle, LogOut, Network, Plus, Power, RefreshCw, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  McpConfigurationSnapshot,
  McpActionResult,
  McpRuntimeStatus,
  McpServerConfiguration,
  McpServerRuntimeStatus,
  RuntimeConfiguration,
} from "@suocode/runtime-protocol";
import { ModelSettings } from "./ModelSettings";
import "./settings.css";

type SettingsSection = "models" | "mcp";
const MASKED_SECRET_VALUE = "••••••";

const mcpStatusLabel: Record<McpServerRuntimeStatus["status"], string> = {
  connected: "已连接",
  "needs-auth": "需要认证",
  failed: "连接失败",
  cached: "已缓存",
  "not connected": "未连接",
  disabled: "已停用",
};

function mcpStatusClass(status: McpServerRuntimeStatus["status"] | undefined): string {
  return status?.replace(" ", "-") ?? "unknown";
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
    disabled: false,
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

  const setEnabled = async (): Promise<void> => {
    if (!selectedName || !cwd) return;
    setActionBusy(true);
    setError(undefined);
    setActionMessage(undefined);
    try {
      const next = await window.suocode.request<McpConfigurationSnapshot>({ type: "set_mcp_server_enabled", name: selectedName, enabled: draft.disabled, cwd }, runtimeId);
      setConfiguration(next);
      selectServer(next.servers.find((server) => server.name === selectedName));
      setActionMessage(draft.disabled ? "已通过 pi-mcp-adapter 在当前项目启用此服务器。" : "已通过 pi-mcp-adapter 在当前项目停用此服务器。");
      void loadStatus();
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
        {runtimeStatus ? <p className="mcp-status-summary">{runtimeStatus.state === "initializing" ? "MCP 扩展初始化中" : runtimeStatus.state === "unavailable" ? "MCP 扩展暂不可用" : `${runtimeStatus.connectedCount} 个已连接 · ${runtimeStatus.totalTools} 个工具 · ${runtimeStatus.totalResources} 个资源${runtimeStatus.disabledCount ? ` · ${runtimeStatus.disabledCount} 个已停用` : ""}`}</p> : null}
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={15} />加载 MCP 配置…</div> : configuration?.servers.map((server) => { const status = runtimeStatus?.servers.find((item) => item.name === server.name); return <button className={server.name === selectedName ? "active" : ""} type="button" key={server.name} onClick={() => selectServer(server, true)}><span className="mcp-server-title"><i className={`mcp-status-dot ${mcpStatusClass(status?.status ?? (server.disabled ? "disabled" : undefined))}`} /><strong>{server.name}</strong>{status && (status.toolCount || status.resourceCount) ? <em>{status.toolCount} 工具 · {status.resourceCount} 资源</em> : null}</span><small>{status ? mcpStatusLabel[status.status] : server.disabled ? "已停用" : server.scope === "project" ? "当前项目" : "全局"} · {server.transport === "http" ? server.url : server.command}</small></button>; })}
        {!loading && !configuration?.servers.length ? <p>尚未配置 MCP 服务器。</p> : null}
      </aside>
      <section className="mcp-editor">
        <form onSubmit={(event) => void save(event)}>
          <div className="mcp-editor-heading"><div><strong>{selectedName ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</strong><small>连接、认证与工具发现均由内置 pi-mcp-adapter 执行。</small></div></div>
          {selectedName ? <div className="mcp-runtime-card"><span><i className={`mcp-status-dot ${mcpStatusClass(selectedStatus?.status ?? (draft.disabled ? "disabled" : undefined))}`} /><strong>{runtimeStatus?.state === "initializing" ? "初始化中" : runtimeStatus?.state === "unavailable" ? "暂不可用" : selectedStatus ? mcpStatusLabel[selectedStatus.status] : draft.disabled ? "已停用" : runtimeId ? "状态未知" : "打开会话后可连接"}</strong>{selectedStatus && (selectedStatus.toolCount || selectedStatus.resourceCount) ? <small>{selectedStatus.toolCount} 个工具 · {selectedStatus.resourceCount} 个资源</small> : null}</span><button type="button" aria-label={draft.disabled ? "启用 MCP 服务器" : "停用 MCP 服务器"} disabled={actionBusy || !cwd} onClick={() => void setEnabled()}><Power size={13} />{draft.disabled ? "启用" : "停用"}</button><button type="button" aria-label="连接 MCP 服务器" disabled={actionBusy || draft.disabled || !runtimeId || runtimeStatus?.state === "initializing"} onClick={() => void connect()}><Cable size={13} />{selectedStatus?.status === "connected" ? "重新连接" : "连接"}</button>{supportsAuth ? <><button type="button" disabled={actionBusy || draft.disabled || !runtimeId || runtimeStatus?.state === "initializing"} onClick={() => void startAuth()}><ExternalLink size={13} />认证</button><button type="button" disabled={actionBusy || !runtimeId || runtimeStatus?.state === "initializing"} onClick={() => void logout()}><LogOut size={13} />登出</button></> : null}</div> : null}
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
    <main className="settings-screen" aria-labelledby="settings-title">
      <aside className="settings-sidebar">
        <div className="settings-window-drag window-drag" />
        <div className="settings-sidebar-brand"><span className="brand-mark">S</span><strong>SuoCode</strong></div>
        <nav className="settings-tabs" aria-label="设置栏目">
          <button className={section === "models" ? "active" : ""} type="button" onClick={() => setSection("models")}><Settings size={15} />模型与服务商</button>
          <button className={section === "mcp" ? "active" : ""} type="button" onClick={() => setSection("mcp")}><Network size={15} />MCP</button>
        </nav>
        <button className="settings-back" type="button" aria-label="关闭设置" onClick={onClose}><ArrowLeft size={15} />返回工作区</button>
      </aside>
      <section className="settings-page" role="region">
        <header className="settings-page-header window-drag"><div><span className="settings-icon">{section === "models" ? <Settings size={17} /> : <Network size={17} />}</span><div><h1 id="settings-title">{section === "models" ? "模型与服务商" : "MCP"}</h1><p>模型凭据和 MCP 配置均保存在 SuoCode 的私有运行时中。</p></div></div></header>
        <div className="settings-page-content">
          {section === "models" ? <ModelSettings configuration={configuration} onSaved={onSaved} runtimeId={runtimeId} /> : <McpSettings runtimeId={runtimeId} cwd={cwd} />}
        </div>
      </section>
    </main>
  );
}
