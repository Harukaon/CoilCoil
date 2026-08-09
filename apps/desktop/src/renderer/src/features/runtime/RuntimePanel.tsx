import {
  AlertCircle,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  CircleDashed,
  GitBranch,
  History,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ContextUsage,
  McpServerRuntimeStatus,
  RuntimeInspectionSnapshot,
  RuntimeSummaryEvent,
  TokenUsage,
} from "@suocode/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";

const kindLabel: Record<RuntimeSummaryEvent["kind"], string> = {
  compaction: "上下文压缩",
  branch_summary: "分支总结",
};

const reasonLabel: Record<NonNullable<RuntimeSummaryEvent["reason"]>, string> = {
  manual: "手动触发",
  threshold: "达到阈值",
  overflow: "溢出恢复",
};

const contextKindLabel: Record<RuntimeInspectionSnapshot["contextItems"][number]["kind"], string> = {
  user: "用户",
  assistant: "回复",
  reasoning: "思考",
  tool_call: "工具调用",
  tool_result: "工具结果",
  custom: "运行时",
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function percent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function SummaryStatus({ event }: { event: RuntimeSummaryEvent }): React.JSX.Element {
  if (event.status === "running") return <><RefreshCw className="spin" size={12} /><span>处理中</span></>;
  if (event.status === "failed") return <><AlertCircle size={12} /><span>失败</span></>;
  if (event.status === "aborted") return <><CircleDashed size={12} /><span>已取消</span></>;
  return <><CheckCircle2 size={12} /><span>已完成</span></>;
}

function SummaryCard({ event }: { event: RuntimeSummaryEvent }): React.JSX.Element {
  const released = event.tokensBefore !== undefined && event.estimatedTokensAfter !== undefined
    ? Math.max(0, event.tokensBefore - event.estimatedTokensAfter)
    : undefined;
  return (
    <details className={`runtime-summary-card ${event.active ? "active" : "historical"}`} open={event.status === "running"}>
      <summary>
        <span className="runtime-summary-kind">{event.kind === "branch_summary" ? <GitBranch size={13} /> : <History size={13} />}{kindLabel[event.kind]}</span>
        <span className={`runtime-summary-status ${event.status}`}><SummaryStatus event={event} /></span>
        <small>{event.active ? "当前上下文" : "历史分支"}</small>
      </summary>
      <div className="runtime-summary-body">
        <div className="runtime-summary-meta">
          <span>{new Date(event.timestamp).toLocaleString("zh-CN", { hour12: false })}</span>
          {event.reason ? <span>{reasonLabel[event.reason]}</span> : null}
          {event.retryAttempt ? <span>重试 {event.retryAttempt}/{event.retryMaxAttempts ?? "?"}</span> : null}
        </div>
        {event.tokensBefore !== undefined || event.estimatedTokensAfter !== undefined ? (
          <dl className="runtime-summary-tokens">
            {event.tokensBefore !== undefined ? <div><dt>压缩前</dt><dd>{compactNumber(event.tokensBefore)}</dd></div> : null}
            {event.estimatedTokensAfter !== undefined ? <div><dt>压缩后</dt><dd>{compactNumber(event.estimatedTokensAfter)}</dd></div> : null}
            {released !== undefined ? <div><dt>释放</dt><dd>{compactNumber(released)}</dd></div> : null}
          </dl>
        ) : null}
        {event.summary ? <pre className="runtime-summary-text">{event.summary}</pre> : null}
        {event.usage ? <p className="runtime-summary-usage">总结请求：输入 {compactNumber(event.usage.input)} · 输出 {compactNumber(event.usage.output)}{event.usage.cacheRead ? ` · 缓存 ${compactNumber(event.usage.cacheRead)}` : ""}</p> : null}
        {event.readFiles?.length ? <div className="runtime-summary-files"><strong>读取文件</strong>{event.readFiles.map((path) => <code key={`read-${path}`}>{path}</code>)}</div> : null}
        {event.modifiedFiles?.length ? <div className="runtime-summary-files"><strong>修改文件</strong>{event.modifiedFiles.map((path) => <code key={`modified-${path}`}>{path}</code>)}</div> : null}
        {event.error ? <p className="runtime-summary-error">{event.error}</p> : null}
      </div>
    </details>
  );
}

function RuntimeSection({
  title,
  icon,
  badge,
  children,
  open = false,
}: {
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
}): React.JSX.Element {
  return (
    <details className="runtime-section" open={open}>
      <summary><span>{icon}<strong>{title}</strong></span>{badge ? <small>{badge}</small> : null}</summary>
      <div className="runtime-section-body">{children}</div>
    </details>
  );
}

function mcpStatusLabel(server: McpServerRuntimeStatus): string {
  if (server.disabled) return "已停用";
  if (server.status === "connected") return "已连接";
  if (server.status === "needs-auth") return "需要认证";
  if (server.status === "failed") return "连接失败";
  if (server.status === "cached") return "已缓存";
  return "未连接";
}

export function RuntimePanel({
  inspection,
  contextUsage,
  tokenUsage,
  runtimeId,
  cwd,
}: {
  inspection?: RuntimeInspectionSnapshot;
  contextUsage?: ContextUsage;
  tokenUsage?: TokenUsage;
  runtimeId?: string;
  cwd?: string;
}): React.JSX.Element {
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(inspection?.effectiveSystemPrompt ?? "");
  const [busyAction, setBusyAction] = useState<string>();
  const summaries = inspection?.summaryEvents ?? [];
  const activeTools = useMemo(() => inspection?.tools.filter((tool) => tool.active) ?? [], [inspection?.tools]);
  const estimateParts = useMemo(() => {
    if (!inspection) return [];
    return [
      inspection.estimates.systemPrompt !== undefined ? `System Prompt ${compactNumber(inspection.estimates.systemPrompt)}` : undefined,
      inspection.estimates.toolDefinitions !== undefined ? `工具定义 ${compactNumber(inspection.estimates.toolDefinitions)}` : undefined,
      inspection.estimates.messages !== undefined ? `消息 ${compactNumber(inspection.estimates.messages)}` : undefined,
    ].filter((item): item is string => Boolean(item));
  }, [inspection]);

  useEffect(() => {
    if (!editingPrompt) setPromptDraft(inspection?.effectiveSystemPrompt ?? "");
  }, [editingPrompt, inspection?.effectiveSystemPrompt]);

  const request = async <T,>(action: string, command: Parameters<typeof window.suocode.request>[0]): Promise<T | undefined> => {
    setBusyAction(action);
    try {
      return await window.suocode.request<T>(command, runtimeId);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  };

  const saveSystemPrompt = async (): Promise<void> => {
    const result = await request<RuntimeInspectionSnapshot>("system-prompt", { type: "set_session_system_prompt", prompt: promptDraft });
    if (!result) return;
    setEditingPrompt(false);
    toastSuccess("当前会话的 System Prompt 已更新");
  };

  const restoreSystemPrompt = async (): Promise<void> => {
    const result = await request<RuntimeInspectionSnapshot>("system-prompt", { type: "set_session_system_prompt" });
    if (!result) return;
    setEditingPrompt(false);
    toastSuccess("已恢复当前会话的默认 System Prompt");
  };

  const setSkillEnabled = async (filePath: string, enabled: boolean): Promise<void> => {
    await request(`skill:${filePath}`, { type: "set_session_skill_enabled", filePath, enabled });
  };

  const setMcpEnabled = async (server: McpServerRuntimeStatus, enabled: boolean): Promise<void> => {
    if (!cwd) return;
    await request(`mcp:${server.name}`, { type: "set_mcp_server_enabled", name: server.name, enabled, cwd });
    await request(`inspection:mcp:${server.name}`, { type: "get_runtime_inspection" });
  };

  const connectMcp = async (server: McpServerRuntimeStatus): Promise<void> => {
    await request(`mcp:${server.name}`, { type: "connect_mcp_server", name: server.name });
    await request(`inspection:mcp:${server.name}`, { type: "get_runtime_inspection" });
  };

  return (
    <div className="runtime-panel">
      <section className="runtime-overview">
        <header><strong>当前运行时</strong><small>会话版本 {inspection?.sessionRevision ?? 0}</small></header>
        {contextUsage ? (
          <div className="runtime-context-meter">
            <span><i style={{ width: `${Math.max(0, Math.min(100, contextUsage.percent ?? 0))}%` }} /></span>
            <p><strong>{contextUsage.tokens === null ? "正在计算" : compactNumber(contextUsage.tokens)}</strong><small>/ {compactNumber(contextUsage.contextWindow)} Token</small></p>
          </div>
        ) : inspection?.estimates.total ? (
          <div className="runtime-context-meter"><p><strong>{compactNumber(inspection.estimates.total)} Token</strong><small>当前上下文估算</small></p></div>
        ) : null}
        {tokenUsage && (tokenUsage.input || tokenUsage.output || tokenUsage.cacheRead || tokenUsage.cacheWrite) ? (
          <dl className="runtime-token-grid">
            {tokenUsage.input ? <div><dt>累计输入</dt><dd>{compactNumber(tokenUsage.input)}</dd></div> : null}
            {tokenUsage.output ? <div><dt>累计输出</dt><dd>{compactNumber(tokenUsage.output)}</dd></div> : null}
            {tokenUsage.cacheRead ? <div><dt>缓存读取</dt><dd>{compactNumber(tokenUsage.cacheRead)}</dd></div> : null}
            {tokenUsage.cacheWrite ? <div><dt>缓存写入</dt><dd>{compactNumber(tokenUsage.cacheWrite)}</dd></div> : null}
            {inspection?.cacheHitRate !== undefined ? <div><dt>缓存命中率</dt><dd>{percent(inspection.cacheHitRate)}</dd></div> : null}
          </dl>
        ) : null}
        {estimateParts.length ? (
          <p className="runtime-estimate-note">估算：{estimateParts.join(" · ")} Token</p>
        ) : null}
      </section>

      <RuntimeSection title="System Prompt" icon={<BrainCircuit size={14} />} badge={inspection?.estimates.systemPrompt ? `估算 ${compactNumber(inspection.estimates.systemPrompt)} Token` : undefined} open>
        {inspection?.effectiveSystemPrompt ? (
          editingPrompt ? (
            <div className="runtime-prompt-editor">
              <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.currentTarget.value)} spellCheck={false} />
              <p>仅影响当前会话；修改 Prompt 可能降低上游提示缓存命中率。</p>
              <div className="runtime-actions"><button type="button" onClick={() => setEditingPrompt(false)}>取消</button><button className="primary" type="button" disabled={busyAction === "system-prompt" || !promptDraft.trim()} onClick={() => { void saveSystemPrompt(); }}><Save size={12} />保存</button></div>
            </div>
          ) : (
            <div className="runtime-prompt-view">
              <pre>{inspection.effectiveSystemPrompt}</pre>
              <div className="runtime-actions"><button type="button" onClick={() => setEditingPrompt(true)}>编辑当前会话</button>{inspection.systemPromptOverride ? <button type="button" disabled={busyAction === "system-prompt"} onClick={() => { void restoreSystemPrompt(); }}><RotateCcw size={12} />恢复默认</button> : null}</div>
            </div>
          )
        ) : <p className="runtime-muted">发送下一条消息后会捕获本次请求真正生效的 System Prompt。</p>}
      </RuntimeSection>

      <RuntimeSection title="上下文明细" icon={<BookOpen size={14} />} badge={inspection?.contextItems.length ? `${inspection.contextItems.length} 项` : undefined}>
        {inspection?.contextItems.length ? <div className="runtime-context-list">{inspection.contextItems.map((item) => (
          <div className="runtime-context-item" key={item.id}>
            <span>{contextKindLabel[item.kind]}</span><strong>{item.label}</strong><small>估算 {compactNumber(item.estimatedTokens)} Token</small>
            {item.preview ? <p>{item.preview}</p> : null}
          </div>
        ))}</div> : <p className="runtime-muted">当前上下文还没有可展示的消息。</p>}
        {inspection ? <div className="runtime-safety-note"><ShieldAlert size={13} /><span>{inspection.capabilities.removeOriginalSessionItemsReason}</span></div> : null}
      </RuntimeSection>

      <RuntimeSection title="工具" icon={<Wrench size={14} />} badge={activeTools.length ? `${activeTools.length}/${inspection?.tools.length ?? 0} 启用` : undefined}>
        {inspection?.tools.length ? <div className="runtime-definition-list">{inspection.tools.map((tool) => (
          <div className={tool.active ? "active" : "inactive"} key={tool.name}><strong>{tool.name}</strong><small>{tool.source} · 估算 {compactNumber(tool.estimatedTokens)} Token</small><p>{tool.description}</p></div>
        ))}</div> : <p className="runtime-muted">尚未取得当前会话的工具定义。</p>}
      </RuntimeSection>

      <RuntimeSection title="Skills" icon={<Sparkles size={14} />} badge={inspection?.skills.length ? `${inspection.skills.filter((skill) => skill.sessionEnabled).length}/${inspection.skills.length}` : undefined}>
        {inspection?.skills.length ? <div className="runtime-toggle-list">{inspection.skills.map((skill) => (
          <label key={skill.filePath}>
            <span><strong>{skill.name}</strong><small>{skill.readInSession ? "本会话已读取" : skill.publishedToModel ? "已向模型公布" : skill.globallyEnabled ? "当前会话未公布" : "全局已停用"}</small></span>
            <input type="checkbox" checked={skill.sessionEnabled} disabled={!skill.globallyEnabled || busyAction === `skill:${skill.filePath}`} onChange={(event) => { void setSkillEnabled(skill.filePath, event.currentTarget.checked); }} />
          </label>
        ))}</div> : <p className="runtime-muted">当前工作区没有发现可用 Skill。</p>}
      </RuntimeSection>

      <RuntimeSection title="MCP" icon={<PlugZap size={14} />} badge={inspection?.mcp ? `${inspection.mcp.connectedCount}/${inspection.mcp.servers.length} 已连接` : undefined}>
        {inspection?.mcp?.servers.length ? <div className="runtime-mcp-list">{inspection.mcp.servers.map((server) => (
          <div key={server.name}>
            <span><strong>{server.name}</strong><small>{mcpStatusLabel(server)}{server.toolCount ? ` · ${server.toolCount} 工具` : ""}</small></span>
            <div>{!server.disabled && server.status !== "connected" ? <button type="button" disabled={busyAction === `mcp:${server.name}`} onClick={() => { void connectMcp(server); }}>连接</button> : null}<button type="button" disabled={!cwd || busyAction === `mcp:${server.name}`} onClick={() => { void setMcpEnabled(server, server.disabled); }}>{server.disabled ? "启用" : "停用"}</button></div>
          </div>
        ))}</div> : <p className="runtime-muted">{inspection?.mcp?.diagnostic || "当前工作区没有 MCP Server。"}</p>}
        <p className="runtime-section-footnote">这里复用 SuoCode 内置的 Pi MCP 扩展；启停会更新当前工作区配置。</p>
      </RuntimeSection>

      <RuntimeSection title="项目记忆" icon={<Sparkles size={14} />} badge={inspection?.memory ? ({ idle: "就绪", running: "整理中", busy: "正忙", succeeded: "已完成", failed: "失败", disabled: "已停用" }[inspection.memory.state]) : undefined} open={inspection?.memory?.state === "running" || inspection?.memory?.state === "failed"}>
        {inspection?.memory ? <div className="runtime-memory-card">
          {inspection.memory.message ? <p>{inspection.memory.message}</p> : null}
          {inspection.memory.error ? <p className="runtime-summary-error">{inspection.memory.error}</p> : null}
          <dl>
            {inspection.memory.memoryFile ? <div><dt>记忆文件</dt><dd title={inspection.memory.memoryFile}>{inspection.memory.memoryFile}</dd></div> : null}
            {inspection.memory.estimatedTokens !== undefined ? <div><dt>内容体积</dt><dd>估算 {compactNumber(inspection.memory.estimatedTokens)} Token</dd></div> : null}
            {inspection.memory.injected ? <div><dt>当前会话</dt><dd>已注入</dd></div> : null}
            {inspection.memory.processedSessions.length ? <div><dt>最近处理</dt><dd>{inspection.memory.processedSessions.length} 个会话</dd></div> : null}
            {inspection.memory.durationMs !== undefined ? <div><dt>耗时</dt><dd>{(inspection.memory.durationMs / 1000).toFixed(1)} 秒</dd></div> : null}
          </dl>
          {inspection.memory.content ? <pre className="runtime-memory-content">{inspection.memory.content}</pre> : null}
          <div className="runtime-actions"><button className="primary" type="button" disabled={!runtimeId || inspection.memory.state === "running" || busyAction === "memory"} onClick={() => { void request("memory", { type: "run_memory_now" }); }}><RefreshCw className={inspection.memory.state === "running" ? "spin" : ""} size={12} />立即整理</button></div>
        </div> : <p className="runtime-muted">Memory 扩展正在初始化。输入 <code>/memory</code> 或点击这里后，运行状态会实时显示。</p>}
      </RuntimeSection>

      <section className="runtime-summaries">
        <header><strong>Pi 总结事件</strong>{summaries.length ? <small>{summaries.filter((event) => event.active).length} 个当前生效</small> : null}</header>
        {summaries.length ? summaries.slice().reverse().map((event) => <SummaryCard key={event.id} event={event} />) : (
          <div className="runtime-summary-empty"><History size={18} /><p>当前会话尚未发生上下文压缩或分支总结。</p></div>
        )}
      </section>
    </div>
  );
}
