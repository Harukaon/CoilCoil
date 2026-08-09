import { AlertCircle, CheckCircle2, CircleDashed, GitBranch, History, RefreshCw } from "lucide-react";
import type {
  ContextUsage,
  RuntimeInspectionSnapshot,
  RuntimeSummaryEvent,
  TokenUsage,
} from "@suocode/runtime-protocol";

const kindLabel: Record<RuntimeSummaryEvent["kind"], string> = {
  compaction: "上下文压缩",
  branch_summary: "分支总结",
};

const reasonLabel: Record<NonNullable<RuntimeSummaryEvent["reason"]>, string> = {
  manual: "手动触发",
  threshold: "达到阈值",
  overflow: "溢出恢复",
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
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

export function RuntimePanel({
  inspection,
  contextUsage,
  tokenUsage,
}: {
  inspection?: RuntimeInspectionSnapshot;
  contextUsage?: ContextUsage;
  tokenUsage?: TokenUsage;
}): React.JSX.Element {
  const summaries = inspection?.summaryEvents ?? [];
  return (
    <div className="runtime-panel">
      <section className="runtime-overview">
        <header><strong>当前运行时</strong><small>版本 {inspection?.sessionRevision ?? 0}</small></header>
        {contextUsage ? (
          <div className="runtime-context-meter">
            <span><i style={{ width: `${Math.max(0, Math.min(100, contextUsage.percent ?? 0))}%` }} /></span>
            <p><strong>{contextUsage.tokens === null ? "正在计算" : compactNumber(contextUsage.tokens)}</strong><small>/ {compactNumber(contextUsage.contextWindow)} Token</small></p>
          </div>
        ) : <p className="runtime-muted">当前 Provider 尚未返回上下文占用。</p>}
        {tokenUsage ? (
          <dl className="runtime-token-grid">
            <div><dt>累计输入</dt><dd>{compactNumber(tokenUsage.input)}</dd></div>
            <div><dt>累计输出</dt><dd>{compactNumber(tokenUsage.output)}</dd></div>
            <div><dt>缓存读取</dt><dd>{compactNumber(tokenUsage.cacheRead)}</dd></div>
            <div><dt>缓存写入</dt><dd>{compactNumber(tokenUsage.cacheWrite)}</dd></div>
          </dl>
        ) : null}
      </section>
      <section className="runtime-summaries">
        <header><strong>Pi 总结事件</strong><small>{summaries.filter((event) => event.active).length} 个正在生效</small></header>
        {summaries.length ? summaries.slice().reverse().map((event) => <SummaryCard key={event.id} event={event} />) : (
          <div className="runtime-summary-empty"><History size={18} /><p>当前会话尚未发生上下文压缩或分支总结。</p></div>
        )}
      </section>
    </div>
  );
}
