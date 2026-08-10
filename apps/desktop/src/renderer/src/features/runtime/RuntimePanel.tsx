import {
  AlertCircle,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  CircleDashed,
  GitBranch,
  History,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ContextUsage,
  McpServerRuntimeStatus,
  RuntimeContextItem,
  RuntimeInspectionSnapshot,
  RuntimeSummaryEvent,
  TokenUsage,
} from "@suocode/runtime-protocol";
import { Modal } from "../../ui/dialog";
import { toastError, toastSuccess } from "../../ui/toast";
import { contextRanking, tokenNumber, toolDisplayName } from "./runtimePresentation";

const kindLabel: Record<RuntimeSummaryEvent["kind"], string> = {
  compaction: "上下文压缩",
  branch_summary: "分支总结",
};

const reasonLabel: Record<NonNullable<RuntimeSummaryEvent["reason"]>, string> = {
  manual: "手动触发",
  threshold: "达到阈值",
  overflow: "溢出恢复",
};

const contextKindLabel: Record<RuntimeContextItem["kind"], string> = {
  user: "用户消息",
  assistant: "模型回复",
  reasoning: "思考内容",
  tool_call: "工具调用",
  tool_result: "工具结果",
  custom: "运行时数据",
};

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
            {event.tokensBefore !== undefined ? <div><dt>压缩前</dt><dd>{tokenNumber(event.tokensBefore)}</dd></div> : null}
            {event.estimatedTokensAfter !== undefined ? <div><dt>压缩后</dt><dd>{tokenNumber(event.estimatedTokensAfter)}</dd></div> : null}
            {released !== undefined ? <div><dt>释放</dt><dd>{tokenNumber(released)}</dd></div> : null}
          </dl>
        ) : null}
        {event.summary ? <pre className="runtime-summary-text">{event.summary}</pre> : null}
        {event.usage ? <p className="runtime-summary-usage">总结请求：输入 {tokenNumber(event.usage.input)} · 输出 {tokenNumber(event.usage.output)}{event.usage.cacheRead ? ` · 缓存 ${tokenNumber(event.usage.cacheRead)}` : ""}</p> : null}
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
  if (server.disabled) return "设置中已停用";
  if (server.sessionDisabled) return "仅当前会话停用";
  if (server.status === "connected") return "当前会话可用";
  if (server.status === "needs-auth") return "需要认证";
  if (server.status === "failed") return "连接失败";
  if (server.status === "cached") return "已缓存，待调用";
  return "尚未连接";
}

export function RuntimePanel({
  inspection,
  contextUsage,
  tokenUsage,
  runtimeId,
}: {
  inspection?: RuntimeInspectionSnapshot;
  contextUsage?: ContextUsage;
  tokenUsage?: TokenUsage;
  runtimeId?: string;
}): React.JSX.Element {
  const [promptOpen, setPromptOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(inspection?.effectiveSystemPrompt ?? "");
  const [busyAction, setBusyAction] = useState<string>();
  const summaries = inspection?.summaryEvents ?? [];
  const activeTools = useMemo(() => inspection?.tools.filter((tool) => tool.active) ?? [], [inspection?.tools]);
  const rankedContext = useMemo(() => contextRanking(inspection?.contextItems ?? []), [inspection?.contextItems]);
  const maxContextTokens = rankedContext[0]?.estimatedTokens ?? 1;
  const tokenMetrics = useMemo(() => [
    tokenUsage?.input ? ["累计输入", tokenNumber(tokenUsage.input)] : undefined,
    tokenUsage?.output ? ["累计输出", tokenNumber(tokenUsage.output)] : undefined,
    tokenUsage?.cacheRead ? ["缓存读取", tokenNumber(tokenUsage.cacheRead)] : undefined,
    tokenUsage?.cacheWrite ? ["缓存写入", tokenNumber(tokenUsage.cacheWrite)] : undefined,
    inspection?.cacheHitRate !== undefined ? ["缓存命中", percent(inspection.cacheHitRate)] : undefined,
  ].filter((item): item is string[] => Boolean(item)), [inspection?.cacheHitRate, tokenUsage]);

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
    setPromptOpen(false);
    toastSuccess("当前会话的 System Prompt 已更新");
  };

  const restoreSystemPrompt = async (): Promise<void> => {
    const result = await request<RuntimeInspectionSnapshot>("system-prompt", { type: "set_session_system_prompt" });
    if (!result) return;
    setEditingPrompt(false);
    setPromptOpen(false);
    toastSuccess("已恢复当前会话的默认 System Prompt");
  };

  const setSkillEnabled = async (filePath: string, enabled: boolean): Promise<void> => {
    await request(`skill:${filePath}`, { type: "set_session_skill_enabled", filePath, enabled });
  };

  const setMcpEnabled = async (server: McpServerRuntimeStatus, enabled: boolean): Promise<void> => {
    await request(`mcp:${server.name}`, { type: "set_session_mcp_server_enabled", name: server.name, enabled });
  };

  const connectMcp = async (server: McpServerRuntimeStatus): Promise<void> => {
    await request(`mcp:${server.name}`, { type: "connect_mcp_server", name: server.name });
    await request(`inspection:mcp:${server.name}`, { type: "get_runtime_inspection" });
  };

  return (
    <div className="runtime-panel">
      <section className="runtime-overview">
        <header><strong>当前运行时</strong><small>会话版本 {inspection?.sessionRevision ?? 0}</small></header>
        <div className="runtime-context-card">
          {contextUsage ? <span className="runtime-progress"><i style={{ width: `${Math.max(0, Math.min(100, contextUsage.percent ?? 0))}%` }} /></span> : null}
          <div className="runtime-context-total">
            <strong>{contextUsage?.tokens === null ? "正在计算" : tokenNumber(contextUsage?.tokens ?? inspection?.estimates.total ?? 0)}</strong>
            <small>{contextUsage ? `/ ${tokenNumber(contextUsage.contextWindow)} Token` : "当前上下文估算"}</small>
          </div>
          {tokenMetrics.length ? <dl className="runtime-metric-strip">{tokenMetrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
          {inspection?.estimates.systemPrompt || inspection?.estimates.toolDefinitions || inspection?.estimates.messages ? (
            <p className="runtime-estimate-note">估算：{[
              inspection.estimates.systemPrompt ? `系统提示词 ${tokenNumber(inspection.estimates.systemPrompt)}` : undefined,
              inspection.estimates.toolDefinitions ? `工具定义 ${tokenNumber(inspection.estimates.toolDefinitions)}` : undefined,
              inspection.estimates.messages ? `消息 ${tokenNumber(inspection.estimates.messages)}` : undefined,
            ].filter(Boolean).join(" · ")} Token</p>
          ) : null}
        </div>
      </section>

      <button className="runtime-entry-card" type="button" onClick={() => setPromptOpen(true)}>
        <span><BrainCircuit size={14} /><strong>系统提示词</strong></span>
        <small>{inspection?.systemPromptOverride ? "当前会话已修改" : inspection?.estimates.systemPrompt ? `${tokenNumber(inspection.estimates.systemPrompt)} Token` : "等待捕获"}</small>
      </button>

      <RuntimeSection title="上下文占用" icon={<BarChart3 size={14} />} badge={rankedContext.length ? `前 ${rankedContext.length} 项` : undefined}>
        {rankedContext.length ? <div className="runtime-context-ranking">{rankedContext.map((item) => (
          <div key={item.id} title={item.preview || item.label}>
            <span className="runtime-context-rank-copy"><small>{contextKindLabel[item.kind]}</small><strong>{item.label}</strong></span>
            <span className="runtime-context-rank-value">{tokenNumber(item.estimatedTokens)}</span>
            <span className="runtime-context-rank-bar"><i style={{ width: `${Math.max(4, item.estimatedTokens / maxContextTokens * 100)}%` }} /></span>
          </div>
        ))}</div> : <p className="runtime-muted">当前上下文还没有可估算的内容。</p>}
        <p className="runtime-section-footnote">只显示占用最大的内容，用于定位上下文中的大体积消息和工具结果。</p>
      </RuntimeSection>

      <RuntimeSection title="工具" icon={<Wrench size={14} />} badge={inspection?.tools.length ? `${activeTools.length}/${inspection.tools.length} 启用` : undefined}>
        {inspection?.tools.length ? <div className="runtime-chip-grid">{inspection.tools.map((tool) => (
          <div className={`runtime-chip ${tool.active ? "active" : "inactive"}`} data-tooltip={tool.description || undefined} title={tool.description || undefined} key={tool.name}>
            <strong>{toolDisplayName(tool.name)}</strong>
            <small>{tool.name} · {tokenNumber(tool.estimatedTokens)} Token</small>
          </div>
        ))}</div> : <p className="runtime-muted">尚未取得当前会话的工具定义。</p>}
      </RuntimeSection>

      <RuntimeSection title="Skills" icon={<Sparkles size={14} />} badge={inspection?.skills.length ? `${inspection.skills.filter((skill) => skill.sessionEnabled).length}/${inspection.skills.length} 可用` : undefined}>
        {inspection?.skills.length ? <div className="runtime-chip-grid">{inspection.skills.map((skill) => (
          <button
            className={`runtime-chip toggle ${skill.sessionEnabled ? "active" : "inactive"}`}
            data-tooltip={skill.description || undefined}
            title={skill.description || undefined}
            disabled={!skill.globallyEnabled || busyAction === `skill:${skill.filePath}`}
            key={skill.filePath}
            type="button"
            onClick={() => { void setSkillEnabled(skill.filePath, !skill.sessionEnabled); }}
          >
            <strong>{skill.name}</strong>
            <small>{!skill.globallyEnabled ? "设置中已停用" : skill.readInSession ? "已读取" : skill.sessionEnabled ? "已提供给 Agent" : "当前会话停用"}</small>
          </button>
        ))}</div> : <p className="runtime-muted">当前工作区没有发现可用 Skill。</p>}
        <p className="runtime-section-footnote">设置页控制工作区是否启用；这里的开关只影响当前会话。</p>
      </RuntimeSection>

      <RuntimeSection title="MCP" icon={<PlugZap size={14} />} badge={inspection?.mcp ? `${inspection.mcp.servers.filter((server) => !server.disabled && !server.sessionDisabled).length}/${inspection.mcp.servers.length} 可用` : undefined}>
        {inspection?.mcp?.servers.length ? <div className="runtime-chip-grid">{inspection.mcp.servers.map((server) => (
          <div className={`runtime-chip mcp ${!server.disabled && !server.sessionDisabled ? "active" : "inactive"}`} key={server.name}>
            <button
              type="button"
              disabled={server.disabled || busyAction === `mcp:${server.name}`}
              title={server.disabled ? "请先在设置中启用这个 MCP Server" : undefined}
              onClick={() => { void setMcpEnabled(server, server.sessionDisabled); }}
            >
              <strong>{server.name}</strong>
              <small>{mcpStatusLabel(server)}{server.toolCount ? ` · ${server.toolCount} 工具` : ""}</small>
            </button>
            {!server.disabled && !server.sessionDisabled && server.status !== "connected" ? <button className="runtime-chip-action" type="button" disabled={busyAction === `mcp:${server.name}`} onClick={() => { void connectMcp(server); }}>连接</button> : null}
          </div>
        ))}</div> : <p className="runtime-muted">{inspection?.mcp?.diagnostic || "当前工作区没有 MCP Server。"}</p>}
        <p className="runtime-section-footnote">设置页控制工作区配置；这里控制当前会话是否允许 Agent 使用。</p>
      </RuntimeSection>

      <RuntimeSection title="项目记忆" icon={<Sparkles size={14} />} badge={inspection?.memory ? ({ idle: "就绪", running: "整理中", busy: "正忙", succeeded: "已完成", failed: "失败", disabled: "已停用" }[inspection.memory.state]) : undefined} open={inspection?.memory?.state === "running" || inspection?.memory?.state === "failed"}>
        {inspection?.memory ? <div className="runtime-memory-card">
          <p className="runtime-section-footnote">这是工作区级记忆；切换或回溯会话不会回滚磁盘上的记忆文件。</p>
          {inspection.memory.message ? <p>{inspection.memory.message}</p> : null}
          {inspection.memory.error ? <p className="runtime-summary-error">{inspection.memory.error}</p> : null}
          <dl>
            {inspection.memory.memoryFile ? <div><dt>记忆文件</dt><dd title={inspection.memory.memoryFile}>{inspection.memory.memoryFile}</dd></div> : null}
            {inspection.memory.estimatedTokens !== undefined ? <div><dt>内容体积</dt><dd>估算 {tokenNumber(inspection.memory.estimatedTokens)} Token</dd></div> : null}
            {inspection.memory.injected ? <div><dt>当前会话</dt><dd>已注入</dd></div> : null}
            {inspection.memory.processedSessions.length ? <div><dt>最近处理</dt><dd>{inspection.memory.processedSessions.length} 个会话</dd></div> : null}
            {inspection.memory.durationMs !== undefined ? <div><dt>耗时</dt><dd>{(inspection.memory.durationMs / 1000).toFixed(1)} 秒</dd></div> : null}
            {inspection.memory.updatedAt ? <div><dt>最近更新</dt><dd>{new Date(inspection.memory.updatedAt).toLocaleString("zh-CN", { hour12: false })}</dd></div> : null}
          </dl>
          {inspection.memory.processedSessions.length ? <div className="runtime-summary-files"><strong>已整理会话</strong>{inspection.memory.processedSessions.map((path) => <code key={path} title={path}>{path.split(/[\\/]/).at(-1) || path}</code>)}</div> : null}
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

      <Modal
        open={promptOpen}
        title="当前会话的系统提示词"
        description="查看真正生效的 System Prompt；修改只影响当前会话，并可能降低提示缓存命中率。"
        size="lg"
        onClose={() => { setPromptOpen(false); setEditingPrompt(false); }}
        footer={<>
          {inspection?.systemPromptOverride ? <button className="suo-modal-button" type="button" disabled={busyAction === "system-prompt"} onClick={() => { void restoreSystemPrompt(); }}><RotateCcw size={12} /> 恢复默认</button> : null}
          {editingPrompt ? <button className="suo-modal-button" type="button" onClick={() => setEditingPrompt(false)}>取消编辑</button> : null}
          {editingPrompt ? <button className="suo-modal-button primary" type="button" disabled={busyAction === "system-prompt" || !promptDraft.trim()} onClick={() => { void saveSystemPrompt(); }}><Save size={12} /> 保存</button> : <button className="suo-modal-button primary" type="button" disabled={!inspection?.effectiveSystemPrompt} onClick={() => setEditingPrompt(true)}>编辑当前会话</button>}
        </>}
      >
        <div className="runtime-prompt-modal">
          {inspection?.effectiveSystemPrompt ? editingPrompt
            ? <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.currentTarget.value)} spellCheck={false} />
            : <pre>{inspection.effectiveSystemPrompt}</pre>
          : <p className="runtime-muted">发送下一条消息后会捕获本次请求真正生效的 System Prompt。</p>}
        </div>
      </Modal>
    </div>
  );
}
