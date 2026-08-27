import { ArrowLeft, ClipboardPaste, ExternalLink, FileJson, Globe, Keyboard, LoaderCircle, LogOut, Network, Palette, Plus, Power, RefreshCw, Settings, Smartphone, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import type {
  McpConfigurationSnapshot,
  McpActionResult,
  McpRuntimeStatus,
  McpServerConfiguration,
  McpServerRuntimeStatus,
  RuntimeConfiguration,
} from "@coilcoil/runtime-protocol";
import { parseMcpServerSnippets } from "@coilcoil/runtime-protocol";
import { Select, type SelectOption } from "../../ui/Select";
import { toastError, toastSuccess } from "../../ui/toast";
import { mcpEnablementClass, mcpEnablementLabel, mcpMountBadge, isMountedMcpServer, mcpOriginLabel } from "../runtime/mcpPolicy";
import { ModelSettings } from "./ModelSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { McpJsonEditor } from "./McpJsonEditor";
import { useMobileRemote } from "../../hooks/useMobileRemote";
import { RemoteSettings } from "./RemoteSettings";
import { BrowserSettings } from "./BrowserSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { SkillSettings } from "./SkillSettings";
import "./settings.css";

/** Keep in step with the sidebar width in mobile.css. */
const SETTINGS_MOBILE_SIDEBAR_WIDTH = 220;

type SettingsSection = "models" | "mcp" | "skills" | "shortcuts" | "remote" | "browser" | "appearance";
const MASKED_SECRET_VALUE = "••••••";
const SETTINGS_SIDEBAR_WIDTH_KEY = "coilcoil.settings-sidebar-width";
const DEFAULT_SETTINGS_SIDEBAR_WIDTH = 220;
const MINIMUM_SETTINGS_SIDEBAR_WIDTH = 160;
const MAXIMUM_SETTINGS_SIDEBAR_WIDTH = 360;
const MCP_SCOPE_OPTIONS: SelectOption[] = [
  { value: "global", label: "全局" },
  { value: "project", label: "当前项目" },
];
const MCP_TRANSPORT_OPTIONS: SelectOption[] = [
  { value: "stdio", label: "stdio 命令" },
  { value: "http", label: "HTTP" },
];
const MCP_AUTH_OPTIONS: SelectOption[] = [
  { value: "auto", label: "自动检测" },
  { value: "oauth", label: "OAuth" },
  { value: "bearer", label: "Bearer" },
  { value: "false", label: "不认证" },
];
const MCP_LIFECYCLE_OPTIONS: SelectOption[] = [
  { value: "lazy", label: "按需连接" },
  { value: "keep-alive", label: "保持连接" },
  { value: "eager", label: "启动时连接" },
];

function storedSettingsSidebarWidth(): number {
  const value = Number(window.localStorage.getItem(SETTINGS_SIDEBAR_WIDTH_KEY));
  return Number.isFinite(value) && value >= MINIMUM_SETTINGS_SIDEBAR_WIDTH
    ? Math.min(MAXIMUM_SETTINGS_SIDEBAR_WIDTH, value)
    : DEFAULT_SETTINGS_SIDEBAR_WIDTH;
}

function ToolPurposePolicyToggle({ configuration, runtimeId, onSaved }: {
  configuration?: RuntimeConfiguration;
  runtimeId?: string;
  onSaved: (configuration: RuntimeConfiguration) => void;
}): React.JSX.Element {
  const [enabled, setEnabled] = useState(configuration?.toolPurposeAuditEnabled ?? true);
  const [saving, setSaving] = useState(false);
  useEffect(() => setEnabled(configuration?.toolPurposeAuditEnabled ?? true), [configuration?.toolPurposeAuditEnabled]);
  const toggle = async (next: boolean): Promise<void> => {
    setEnabled(next);
    setSaving(true);
    try {
      const configuration = await window.coilcoil.request<RuntimeConfiguration>({ type: "set_tool_purpose_audit_enabled", enabled: next }, runtimeId);
      onSaved(configuration);
      toastSuccess(next ? "已开启工具调用意图记录。" : "已关闭工具调用意图强制校验。");
    } catch (caught) {
      setEnabled(!next);
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };
  return <label
    className="settings-policy-toggle no-window-drag"
    title="每次工具调用都要求填写简短的直接目的，并记录在会话中。"
  >
    <input
      type="checkbox"
      aria-label="强制工具调用填写目的"
      checked={enabled}
      disabled={saving || !runtimeId}
      onChange={(event) => { void toggle(event.target.checked); }}
    />
    <span>工具目的</span>
  </label>;
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

function McpSettings({ runtimeId, cwd, reloadKey = 0 }: { runtimeId?: string; cwd?: string; reloadKey?: number }): React.JSX.Element {
  const [configuration, setConfiguration] = useState<McpConfigurationSnapshot>();
  const [selectedName, setSelectedName] = useState<string>();
  const [draft, setDraft] = useState<McpServerConfiguration>(blankMcpServer);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("{}");
  const [headersText, setHeadersText] = useState("{}");
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [snippetText, setSnippetText] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string>();
  const [originalEnv, setOriginalEnv] = useState<Record<string, string>>({});
  const [originalHeaders, setOriginalHeaders] = useState<Record<string, string>>({});
  const [directToolsText, setDirectToolsText] = useState("");
  const [excludeToolsText, setExcludeToolsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [listRemoveArmed, setListRemoveArmed] = useState<string>();
  const [runtimeStatus, setRuntimeStatus] = useState<McpRuntimeStatus>();
  const [authorizationUrl, setAuthorizationUrl] = useState<string>();
  const [authInput, setAuthInput] = useState("");
  const editVersionRef = useRef(0);
  const loadVersionRef = useRef(0);

  /**
   * Fill the form from a pasted configuration.
   *
   * What people have to hand is whatever a README or another app showed them,
   * which is usually a bare server object with no name. Everything it carries
   * lands in the form, and the pi-specific choices - scope, lifecycle, auth -
   * stay where they are, to be set here afterwards.
   */
  const applySnippet = (): void => {
    const result = parseMcpServerSnippets(snippetText);
    if (!result.ok) {
      toastError(result.error);
      return;
    }
    const [snippet, ...rest] = result.servers;
    if (!snippet) return;
    setDraft((current) => ({
      ...current,
      name: snippet.name ?? current.name,
      transport: snippet.transport,
      command: snippet.transport === "stdio" ? snippet.command ?? "" : undefined,
      url: snippet.transport === "http" ? snippet.url ?? "" : undefined,
      cwd: snippet.cwd,
    }));
    setArgsText(snippet.args.join("\n"));
    setEnvText(JSON.stringify(snippet.env, null, 2));
    setHeadersText(JSON.stringify(snippet.headers, null, 2));
    // Pasted secrets are the real values, so the masking table must forget what
    // it held for the server that was on screen a moment ago.
    setOriginalEnv({});
    setOriginalHeaders({});
    setSnippetOpen(false);
    setSnippetText("");
    toastSuccess(rest.length
      ? `已填入「${snippet.name ?? "未命名"}」，另外 ${rest.length} 个服务器请分别粘贴。`
      : snippet.name ? `已填入「${snippet.name}」，确认后保存。` : "已填入配置，请补一个名称后保存。");
  };

  /**
   * Ask the server itself whether the address and headers are right.
   *
   * "Failed to connect" is the same message for a wrong URL, a rejected key and
   * a server that is down. The handshake reply usually names the problem, so it
   * is shown verbatim rather than summarised into another vague sentence.
   */
  const probeConnection = async (): Promise<void> => {
    setProbing(true);
    setProbeResult(undefined);
    try {
      const headers = parseStringMap(headersText, "请求头", originalHeaders);
      const result = await window.coilcoil.testMcpConnection({ url: draft.url ?? "", headers });
      if (!result.ok) {
        setProbeResult(`连接失败：${result.error}`);
        return;
      }
      const healthy = result.status >= 200 && result.status < 300;
      setProbeResult(`HTTP ${result.status} ${result.statusText}${healthy ? "" : " · 服务器拒绝了这次握手"}${result.body ? `\n${result.body}` : ""}`);
    } catch (caught) {
      setProbeResult(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setProbing(false);
    }
  };

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
    setAuthorizationUrl(undefined);
    setAuthInput("");
    setProbeResult(undefined);
    setRemoveArmed(false);
    setListRemoveArmed(undefined);
  };

  const loadStatus = async (surfaceError = false): Promise<void> => {
    if (!runtimeId) {
      setRuntimeStatus(undefined);
      if (surfaceError) toastError("打开一个会话后即可查看 MCP 连接状态。");
      return;
    }
    setStatusLoading(true);
    try {
      setRuntimeStatus(await window.coilcoil.request<McpRuntimeStatus>({ type: "get_mcp_status" }, runtimeId));
    } catch (caught) {
      setRuntimeStatus(undefined);
      if (surfaceError) toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStatusLoading(false);
    }
  };

  const load = async (): Promise<void> => {
    const loadVersion = ++loadVersionRef.current;
    const editVersion = editVersionRef.current;
    setLoading(true);
    try {
      const next = await window.coilcoil.request<McpConfigurationSnapshot>({ type: "get_mcp_configuration", cwd }, runtimeId);
      if (loadVersion !== loadVersionRef.current) return;
      setConfiguration(next);
      if (editVersion === editVersionRef.current) {
        const selected = next.servers.find((server) => server.name === selectedName) ?? next.servers[0];
        selectServer(selected);
      }
    } catch (caught) {
      if (loadVersion !== loadVersionRef.current) return;
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (loadVersion === loadVersionRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void loadStatus();
  }, [cwd, runtimeId, reloadKey]);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
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
      const next = await window.coilcoil.request<McpConfigurationSnapshot>({ type: "save_mcp_server", server, previousName: selectedName, cwd }, runtimeId);
      setConfiguration(next);
      selectServer(next.servers.find((item) => item.name === server.name));
      void loadStatus();
      toastSuccess("已保存 MCP 服务器。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const enableDetectedImports = async (): Promise<void> => {
    const imports = configuration?.imports.filter((item) => !item.enabled).map((item) => item.kind) ?? [];
    if (!imports.length) return;
    setSaving(true);
    try {
      setConfiguration(await window.coilcoil.request<McpConfigurationSnapshot>({ type: "enable_mcp_imports", imports, cwd }, runtimeId));
      toastSuccess("已导入检测到的兼容配置。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const applyActionResult = (result: McpActionResult): void => {
    if (result.status) setRuntimeStatus(result.status);
    const detailsError = typeof result.details?.error === "string" ? result.details.error : undefined;
    if (detailsError) {
      toastError(typeof result.details?.message === "string" ? result.details.message : detailsError);
      return;
    }
    toastSuccess(result.text || "MCP 扩展已完成操作。");
  };

  const startAuth = async (): Promise<void> => {
    if (!selectedName) return;
    setActionBusy(true);
    try {
      const result = await window.coilcoil.request<McpActionResult>({ type: "start_mcp_auth", name: selectedName }, runtimeId);
      applyActionResult(result);
      const url = typeof result.details?.authorizationUrl === "string" ? result.details.authorizationUrl : undefined;
      setAuthorizationUrl(url);
      if (url) await window.coilcoil.openExternal(url);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const completeAuth = async (): Promise<void> => {
    if (!selectedName || !authInput.trim()) return;
    setActionBusy(true);
    try {
      const result = await window.coilcoil.request<McpActionResult>({ type: "complete_mcp_auth", name: selectedName, input: authInput }, runtimeId);
      applyActionResult(result);
      if (!result.details?.error) {
        setAuthorizationUrl(undefined);
        setAuthInput("");
      }
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    if (!selectedName) return;
    setActionBusy(true);
    try {
      applyActionResult(await window.coilcoil.request<McpActionResult>({ type: "logout_mcp_server", name: selectedName }, runtimeId));
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const setEnabled = async (): Promise<void> => {
    if (!selectedName || !cwd) return;
    const name = selectedName;
    const enabling = draft.disabled;
    // Writing the override reloads the MCP extension, so the authoritative
    // answer only arrives with the response. Reflect it optimistically and keep
    // a spinner up until it lands, instead of leaving the button looking inert.
    setDraft((current) => ({ ...current, disabled: !enabling }));
    setTogglingEnabled(true);
    try {
      const next = await window.coilcoil.request<McpConfigurationSnapshot>({ type: "set_mcp_server_enabled", name, enabled: enabling, cwd }, runtimeId);
      setConfiguration(next);
      const saved = next.servers.find((server) => server.name === name);
      if (saved) setDraft((current) => ({ ...current, disabled: saved.disabled }));
      toastSuccess(enabling ? `已启用 ${name}` : `已停用 ${name}（Agent 将看不到它）`);
      await loadStatus();
    } catch (caught) {
      setDraft((current) => ({ ...current, disabled: enabling }));
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTogglingEnabled(false);
    }
  };

  const remove = async (name = selectedName, scope = draft.scope): Promise<void> => {
    if (!name) return;
    const removing = name;
    setSaving(true);
    try {
      const next = await window.coilcoil.request<McpConfigurationSnapshot>({
        type: "remove_mcp_server",
        name: removing,
        scope,
        cwd,
      }, runtimeId);
      setConfiguration(next);
      if (selectedName === removing) {
        const fallback = next.servers.find((server) => server.name !== removing);
        selectServer(fallback, true);
      } else {
        setListRemoveArmed(undefined);
      }
      void loadStatus();
      toastSuccess(`已删除 MCP 服务器 ${removing}。`);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
      void load();
      void loadStatus();
    } finally {
      setSaving(false);
      setRemoveArmed(false);
      setListRemoveArmed(undefined);
    }
  };

  const selectedStatus = runtimeStatus?.servers.find((server) => server.name === selectedName);
  const mounted = Boolean(selectedName) && isMountedMcpServer(draft);
  const supportsAuth = draft.transport === "http" && draft.auth !== false;

  return (
    <div className="mcp-settings">
      <aside className="mcp-server-list">
        <div className="mcp-list-toolbar"><button className="mcp-add-button" type="button" disabled={loading} onClick={() => selectServer(undefined, true)}><Plus size={13} />添加服务器</button><button className="mcp-refresh-button" type="button" aria-label="刷新 MCP 状态" disabled={statusLoading || !runtimeId} onClick={() => void loadStatus(true)}>{statusLoading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button></div>
        {runtimeStatus ? <p className="mcp-status-summary">{runtimeStatus.state === "initializing" ? "MCP 扩展初始化中" : runtimeStatus.state === "unavailable" ? "MCP 扩展暂不可用" : `${runtimeStatus.servers.length - runtimeStatus.disabledCount} 个已启用 · ${runtimeStatus.totalTools} 个工具 · ${runtimeStatus.totalResources} 个资源${runtimeStatus.disabledCount ? ` · ${runtimeStatus.disabledCount} 个已停用` : ""}`}</p> : null}
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={15} />加载 MCP 配置…</div> : configuration?.servers.map((server) => {
          const status = runtimeStatus?.servers.find((item) => item.name === server.name);
          const armed = listRemoveArmed === server.name;
          return (
            <div className={`mcp-server-row${server.name === selectedName ? " active" : ""}`} key={server.name}>
              <button className="mcp-server-select" type="button" onClick={() => selectServer(server, true)}>
                <span className="mcp-server-title">
                  <i className={`mcp-status-dot ${mcpEnablementClass(server, status)}`} />
                  <strong>{server.name}</strong>
                </span>
                <span className="mcp-server-meta">
                  {mcpMountBadge(server) ? <em className="mounted">{mcpOriginLabel(server)}</em> : null}
                  {status && (status.toolCount || status.resourceCount) ? <em>{status.toolCount} 工具 · {status.resourceCount} 资源</em> : null}
                  <small>{mcpEnablementLabel(server, status)} · {server.transport === "http" ? server.url : server.command}</small>
                </span>
              </button>
              <button
                className={`mcp-server-remove${armed ? " armed" : ""}`}
                type="button"
                aria-label={armed ? `再次点击确认删除 ${server.name}` : `删除 ${server.name}`}
                title={armed ? "再次点击确认删除" : "删除"}
                disabled={saving || actionBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  if (armed) void remove(server.name, server.scope);
                  else setListRemoveArmed(server.name);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
        {!loading && !configuration?.servers.length ? <p>尚未配置 MCP 服务器。</p> : null}
        {!loading ? <p className="mcp-list-hint">启用即交给 Agent 使用，具体何时连接由该服务器的生命周期决定（按需 / 保持 / 启动时）。停用表示 Agent 永远看不到它。</p> : null}
      </aside>
      <section className="mcp-editor">
        <form onSubmit={(event) => void save(event)}>
          <div className="mcp-editor-heading"><div><strong>{selectedName ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</strong><small>连接、认证与工具发现均由内置 pi-mcp-adapter 执行。</small></div></div>
          {selectedName ? <div className="mcp-runtime-card"><span><i className={`mcp-status-dot ${mcpEnablementClass(draft, selectedStatus)}`} /><strong>{mcpEnablementLabel(draft, selectedStatus)}</strong>{selectedStatus && (selectedStatus.toolCount || selectedStatus.resourceCount) ? <small>{selectedStatus.toolCount} 个工具 · {selectedStatus.resourceCount} 个资源</small> : null}</span><button type="button" aria-label={draft.disabled ? "启用 MCP 服务器" : "停用 MCP 服务器"} disabled={togglingEnabled || actionBusy || !cwd} onClick={() => void setEnabled()}>{togglingEnabled ? <LoaderCircle className="spin" size={13} /> : <Power size={13} />}{draft.disabled ? "启用" : "停用"}</button>{supportsAuth ? <><button type="button" disabled={actionBusy || draft.disabled || !runtimeId || runtimeStatus?.state === "initializing"} onClick={() => void startAuth()}><ExternalLink size={13} />认证</button><button type="button" disabled={actionBusy || !runtimeId || runtimeStatus?.state === "initializing"} onClick={() => void logout()}><LogOut size={13} />登出</button></> : null}</div> : null}
          {runtimeStatus?.diagnostic ? <p className="mcp-source-note">{runtimeStatus.diagnostic}</p> : null}
          {mounted ? <p className="mcp-source-note">这个服务器挂载自 {mcpOriginLabel(draft)}，定义保存在 <code>{draft.source}</code>。CoilCoil 只叠加启用状态等本地覆盖，要改命令、地址或请求头请到该应用里编辑。</p> : null}
          {mounted ? null : <div className="mcp-snippet">
            <button className="mcp-snippet-toggle" type="button" onClick={() => setSnippetOpen((current) => !current)}><ClipboardPaste size={13} />{snippetOpen ? "收起 JSON 粘贴" : "粘贴 MCP JSON 配置"}</button>
            {snippetOpen ? <>
              <textarea value={snippetText} placeholder={'{\n  "command": "npx",\n  "args": ["-y", "chrome-devtools-mcp@latest"]\n}'} onChange={(event) => setSnippetText(event.target.value)} />
              <div className="mcp-snippet-actions">
                <small>支持完整的 mcpServers 文档、单个服务器对象，或「名称: 配置」这一对。</small>
                <button type="button" onClick={applySnippet}>填入表单</button>
              </div>
            </> : null}
          </div>}
          <fieldset className="mcp-definition-fields" disabled={mounted}>
          <div className="settings-grid"><label>名称<input value={draft.name} placeholder="例如 github" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label><label>作用域<Select value={draft.scope} options={MCP_SCOPE_OPTIONS} disabled={!cwd} ariaLabel="MCP 作用域" onChange={(scope) => setDraft((current) => ({ ...current, scope: scope as McpServerConfiguration["scope"] }))} /></label></div>
          <label>连接方式<Select value={draft.transport} options={MCP_TRANSPORT_OPTIONS} ariaLabel="MCP 连接方式" onChange={(transport) => setDraft((current) => ({ ...current, transport: transport as McpServerConfiguration["transport"] }))} /></label>
          {draft.transport === "stdio" ? <><label>启动命令<input value={draft.command ?? ""} placeholder="npx" onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} /></label><label>参数（每行一个）<textarea value={argsText} placeholder="-y&#10;@modelcontextprotocol/server-filesystem" onChange={(event) => setArgsText(event.target.value)} /></label><div className="settings-grid"><label>工作目录<input value={draft.cwd ?? ""} placeholder="可选" onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} /></label><label>环境变量 JSON<textarea value={envText} onChange={(event) => setEnvText(event.target.value)} /></label></div></> : <><label>服务器地址<input value={draft.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} /></label><div className="settings-grid"><label>认证<Select value={String(draft.auth ?? "auto")} options={MCP_AUTH_OPTIONS} ariaLabel="MCP HTTP 认证方式" onChange={(auth) => setDraft((current) => ({ ...current, auth: auth === "auto" ? undefined : auth === "false" ? false : auth as "oauth" | "bearer" }))} /></label><label>Bearer 环境变量<input value={draft.bearerTokenEnv ?? ""} placeholder="例如 GITHUB_TOKEN" onChange={(event) => setDraft((current) => ({ ...current, bearerTokenEnv: event.target.value }))} /></label></div><label>请求头 JSON<textarea value={headersText} onChange={(event) => setHeadersText(event.target.value)} /></label><div className="mcp-probe"><button type="button" disabled={probing || !draft.url?.trim()} onClick={() => void probeConnection()}>{probing ? <LoaderCircle className="spin" size={13} /> : <Network size={13} />}测试连接</button>{probeResult ? <pre className="mcp-probe-result">{probeResult}</pre> : null}</div></>}
          <div className="settings-grid"><label>生命周期<Select value={draft.lifecycle} options={MCP_LIFECYCLE_OPTIONS} ariaLabel="MCP 生命周期" onChange={(lifecycle) => setDraft((current) => ({ ...current, lifecycle: lifecycle as McpServerConfiguration["lifecycle"] }))} /></label><label>空闲超时（分钟）<input type="number" min="0" value={draft.idleTimeout ?? ""} placeholder="使用扩展默认值" onChange={(event) => setDraft((current) => ({ ...current, idleTimeout: event.target.value ? Number(event.target.value) : undefined }))} /></label></div>
          <div className="settings-grid"><label>请求超时（毫秒）<input type="number" min="0" value={draft.requestTimeoutMs ?? ""} placeholder="使用扩展默认值" onChange={(event) => setDraft((current) => ({ ...current, requestTimeoutMs: event.target.value ? Number(event.target.value) : undefined }))} /></label><label className="checkbox-setting"><input type="checkbox" checked={draft.debug} onChange={(event) => setDraft((current) => ({ ...current, debug: event.target.checked }))} />显示服务器调试输出</label></div>
          <div className="settings-grid"><label>直接注册的工具（每行一个）<textarea value={directToolsText} placeholder="留空时使用下面的全部开关" onChange={(event) => setDirectToolsText(event.target.value)} /></label><label>排除工具（每行一个）<textarea value={excludeToolsText} onChange={(event) => setExcludeToolsText(event.target.value)} /></label></div>
          <div className="settings-grid"><label className="checkbox-setting"><input type="checkbox" checked={draft.directTools === true} disabled={Boolean(directToolsText.trim())} onChange={(event) => setDraft((current) => ({ ...current, directTools: event.target.checked }))} />直接注册全部服务器工具</label><label className="checkbox-setting"><input type="checkbox" checked={draft.exposeResources} onChange={(event) => setDraft((current) => ({ ...current, exposeResources: event.target.checked }))} />向 Agent 暴露资源</label></div>
          </fieldset>
          {draft.sourceKind === "import" || (draft.source && draft.source !== configuration?.configPath) ? <p className="mcp-source-note">{draft.sourceKind === "import" ? <>当前条目来自外部导入{draft.source ? `（${draft.source}）` : ""}。删除只会从 CoilCoil 列表中移除并本地停用，不会修改外部应用配置。保存会写入 CoilCoil 私有覆盖。</> : <>当前配置来自 {draft.source}。保存后会在 CoilCoil 私有配置中创建同名覆盖，不会修改外部应用。</>}</p> : null}
          {authorizationUrl ? <div className="mcp-auth-panel"><strong>完成 OAuth 认证</strong><p>浏览器已打开扩展生成的授权地址。完成授权后，粘贴回调地址或授权码。</p><button type="button" onClick={() => void window.coilcoil.openExternal(authorizationUrl)}><ExternalLink size={13} />重新打开授权页</button><textarea value={authInput} placeholder="粘贴回调地址或授权码" onChange={(event) => setAuthInput(event.target.value)} /><button className="primary-button" type="button" disabled={actionBusy || !authInput.trim()} onClick={() => void completeAuth()}>完成认证</button></div> : null}
          <footer>
            <span>{configuration?.configPath}</span>
            <div className="mcp-editor-footer-actions">
              {selectedName ? <button className={removeArmed ? "danger-text-button armed" : "danger-text-button"} type="button" disabled={saving || actionBusy} onClick={() => removeArmed ? void remove() : setRemoveArmed(true)}>{removeArmed ? "再次点击确认移除" : <><Trash2 size={14} />{mounted ? "移除" : "删除"}</>}</button> : null}
              {mounted ? null : <button className="primary-button" type="submit" disabled={saving || !draft.name.trim()}>{saving ? <LoaderCircle className="spin" size={15} /> : null}保存 MCP</button>}
            </div>
          </footer>
        </form>
        {configuration?.imports.length ? <div className="mcp-imports"><div><strong>检测到的兼容配置</strong><small>由 pi-mcp-adapter 负责解析 Cursor、Claude、Codex 等现有配置。</small></div><div className="mcp-import-list">{configuration.imports.map((item) => <span className={item.enabled ? "enabled" : ""} key={`${item.kind}-${item.path}`}><b>{item.kind}</b><small>{item.serverCount} 个服务器</small></span>)}</div>{configuration.imports.some((item) => !item.enabled) ? <button type="button" disabled={saving} onClick={() => void enableDetectedImports()}>导入检测到的配置</button> : null}</div> : null}
      </section>
    </div>
  );
}

export function SettingsDialog({ configuration, open, onClose, onSaved, runtimeId, cwd, initialSection = "models" }: {
  configuration?: RuntimeConfiguration;
  open: boolean;
  onClose: () => void;
  onSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
  cwd?: string;
  initialSection?: SettingsSection;
}): React.JSX.Element | null {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const mobile = useMobileRemote();
  /**
   * Two pages stay on the Mac.
   *
   * A global shortcut only means anything to the machine the keyboard is
   * attached to, and remote access is the thing the phone is currently holding
   * open — turning it off from there would strand whoever is using it.
   */
  const hidden = mobile && (section === "shortcuts" || section === "remote" || section === "browser");
  const shown: SettingsSection = hidden ? "models" : section;
  const [sidebarWidth, setSidebarWidth] = useState(storedSettingsSidebarWidth);
  const [mcpJsonOpen, setMcpJsonOpen] = useState(false);
  const [mcpReloadKey, setMcpReloadKey] = useState(0);
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    let cancelled = false;
    void window.coilcoil.appVersion()
      .then((version) => { if (!cancelled) setAppVersion(version); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (open) setSection(initialSection);
    else {
      setSection("models");
      setMcpJsonOpen(false);
    }
  }, [initialSection, open]);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let finalWidth = startWidth;
    const screen = event.currentTarget.closest(".settings-screen") as HTMLElement | null;
    document.body.classList.add("resizing-panels");
    const move = (pointer: PointerEvent): void => {
      finalWidth = Math.round(Math.max(
        MINIMUM_SETTINGS_SIDEBAR_WIDTH,
        Math.min(MAXIMUM_SETTINGS_SIDEBAR_WIDTH, startWidth + pointer.clientX - startX),
      ));
      screen?.style.setProperty("--settings-sidebar-width", `${finalWidth}px`);
    };
    const stop = (): void => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      setSidebarWidth(finalWidth);
      window.localStorage.setItem(SETTINGS_SIDEBAR_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [sidebarWidth]);

  /**
   * The settings screen is one wide canvas on a phone, not a rebuilt layout.
   *
   * Pages like MCP carry dense tables and long paths that would each need their
   * own mobile design. Keeping the desktop widths and letting the phone pan
   * across them costs nothing and behaves the same on every page: swipe left
   * for the section list, swipe right for the page itself.
   */
  const screenRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const screen = screenRef.current;
    if (!open || !mobile || !screen) return;
    const frame = window.requestAnimationFrame(() => {
      // Land on the page rather than the section list: the caller already chose
      // which page to open.
      screen.scrollLeft = SETTINGS_MOBILE_SIDEBAR_WIDTH;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, mobile]);

  if (!open) return null;
  return (
    <main ref={screenRef} className="settings-screen" aria-labelledby="settings-title" style={{ "--settings-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className="settings-sidebar">
        <div className="settings-window-drag window-drag" />
        <button className="settings-sidebar-home" type="button" aria-label="返回工作区" onClick={onClose}><ArrowLeft size={15} /><span>返回工作区</span></button>
        <nav className="settings-tabs" aria-label="设置栏目">
          <button className={section === "models" ? "active" : ""} type="button" onClick={() => setSection("models")}><Settings size={15} />模型与服务商</button>
          <button className={section === "mcp" ? "active" : ""} type="button" onClick={() => setSection("mcp")}><Network size={15} />MCP</button>
          <button className={section === "skills" ? "active" : ""} type="button" onClick={() => setSection("skills")}><Sparkles size={15} />技能</button>
          {mobile ? null : <button className={section === "shortcuts" ? "active" : ""} type="button" onClick={() => setSection("shortcuts")}><Keyboard size={15} />快捷键</button>}
          {mobile ? null : <button className={section === "remote" ? "active" : ""} type="button" onClick={() => setSection("remote")}><Smartphone size={15} />远程控制</button>}
          {mobile ? null : <button className={section === "browser" ? "active" : ""} type="button" onClick={() => setSection("browser")}><Globe size={15} />浏览器</button>}
          <button className={section === "appearance" ? "active" : ""} type="button" onClick={() => setSection("appearance")}><Palette size={15} />外观</button>
        </nav>
        <div className="settings-version" title={appVersion ? `CoilCoil ${appVersion}` : undefined}>
          {appVersion ? `CoilCoil ${appVersion}` : ""}
        </div>
      </aside>
      <div className="settings-sidebar-resizer" role="separator" aria-label="调整设置侧栏宽度" aria-orientation="vertical" onPointerDown={beginSidebarResize} />
      <section className="settings-page" role="region">
        <header className="settings-page-header window-drag">
          <div>
            <span className="settings-icon">
              {shown === "models" ? <Settings size={17} /> : shown === "mcp" ? <Network size={17} /> : shown === "appearance" ? <Palette size={17} /> : shown === "shortcuts" ? <Keyboard size={17} /> : shown === "remote" ? <Smartphone size={17} /> : shown === "browser" ? <Globe size={17} /> : <Sparkles size={17} />}
            </span>
            <div>
              <h1 id="settings-title">{shown === "models" ? "模型与服务商" : shown === "mcp" ? "MCP" : shown === "appearance" ? "外观" : shown === "shortcuts" ? "快捷键" : shown === "remote" ? "远程控制" : shown === "browser" ? "浏览器" : "技能"}</h1>
              <p>
                {shown === "browser"
                  ? "内置浏览器的登录状态：从别的浏览器导入，或者一键清空。"
                  : shown === "remote"
                  ? "从手机遥控这台 Mac，配对码只在这里显示。"
                  : shown === "skills"
                  ? "按需加载的专业技能包。"
                  : shown === "appearance"
                    ? "全局色调，一键切换并本机保存。"
                    : shown === "shortcuts"
                      ? "全局快捷键会被系统里所有应用共享，所以默认一个都不占用。"
                      : "模型凭据和 MCP 配置均保存在 CoilCoil 的私有运行时中。"}
              </p>
            </div>
          </div>
          {shown === "models" ? (
            <ToolPurposePolicyToggle configuration={configuration} runtimeId={runtimeId} onSaved={onSaved} />
          ) : shown === "mcp" ? (
            <button
              className="settings-header-action no-window-drag"
              type="button"
              onClick={() => setMcpJsonOpen(true)}
            >
              <FileJson size={14} />打开 JSON 配置
            </button>
          ) : null}
        </header>
        <div className="settings-page-content">
          {shown === "models" ? (
            <ModelSettings configuration={configuration} onSaved={onSaved} runtimeId={runtimeId} />
          ) : shown === "mcp" ? (
            <McpSettings runtimeId={runtimeId} cwd={cwd} reloadKey={mcpReloadKey} />
          ) : shown === "shortcuts" ? (
            <ShortcutSettings />
          ) : shown === "remote" ? (
            <RemoteSettings />
          ) : shown === "browser" ? (
            <BrowserSettings />
          ) : shown === "appearance" ? (
            <AppearanceSettings />
          ) : (
            <SkillSettings runtimeId={runtimeId} cwd={cwd} />
          )}
        </div>
      </section>
      <McpJsonEditor
        open={mcpJsonOpen}
        cwd={cwd}
        runtimeId={runtimeId}
        onClose={() => setMcpJsonOpen(false)}
        onSaved={() => setMcpReloadKey((value) => value + 1)}
      />
    </main>
  );
}
