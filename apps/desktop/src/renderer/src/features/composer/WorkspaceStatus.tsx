import * as Popover from "@radix-ui/react-popover";
import { FileCode2 } from "lucide-react";
import { useState } from "react";
import type { CSSProperties } from "react";
import { summarizeCacheUsage } from "@coilcoil/runtime-protocol";
import type { ContextUsage, ProjectSelection, ResponseMetrics, RuntimeTokenBreakdown, TokenUsage } from "@coilcoil/runtime-protocol";

function pathLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || path;
}

function formatMetricDuration(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "—" : `${(milliseconds / 1_000).toFixed(2)}s`;
}

function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return "—";
  if (tokens < 1_000) return String(Math.round(tokens));
  return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function performanceGrade(metrics: ResponseMetrics): "excellent" | "good" | "fair" | "slow" {
  const firstToken = metrics.firstTokenMs ?? Number.POSITIVE_INFINITY;
  const speed = metrics.averageTokensPerSecond ?? 0;
  if (firstToken <= 2_000 && speed >= 50) return "excellent";
  if (firstToken <= 5_000 && speed >= 25) return "good";
  if (firstToken <= 20_000 && speed >= 10) return "fair";
  return "slow";
}

export function WorkspaceStatus({
  project,
  responseMetrics,
  responseMetricsHistory,
  contextUsage,
  tokenUsage,
  tokenBreakdown,
}: {
  project: ProjectSelection | null;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  contextUsage?: ContextUsage;
  tokenUsage?: TokenUsage;
  tokenBreakdown?: RuntimeTokenBreakdown;
}): React.JSX.Element {
  const [pathOpen, setPathOpen] = useState(false);
  const percent = Math.max(0, Math.min(100, contextUsage?.percent ?? 0));
  const firstTokenText = responseMetrics?.firstTokenMs === undefined ? undefined : `首字 ${formatMetricDuration(responseMetrics.firstTokenMs)}`;
  const speedText = responseMetrics?.averageTokensPerSecond === undefined ? undefined : `${responseMetrics.averageTokensPerSecond.toFixed(1)} tok/s`;
  const metricSummary = [firstTokenText, speedText].filter(Boolean).join(" · ");
  const hasPerformanceHistory = responseMetricsHistory.length > 0;
  const cumulativeCache = summarizeCacheUsage(tokenUsage?.input, tokenUsage?.cacheRead, tokenUsage?.cacheWrite);
  return (
    <div className="workspace-status">
      <Popover.Root open={pathOpen} onOpenChange={setPathOpen}>
        <Popover.Trigger asChild>
          <button className="workspace-path" type="button" title={project?.path ?? "未选择项目"}>
            <FileCode2 size={13} />
            <span>{project ? pathLabel(project.path) : "未选择项目"}</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="path-popover" side="top" align="start" sideOffset={7}>
            {project?.path ?? "未选择项目"}
            <Popover.Arrow className="model-popover-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="composer-metrics">
        {metricSummary ? <span className="response-metrics">{metricSummary}</span> : null}
        {responseMetrics || hasPerformanceHistory ? <Popover.Root>
          <Popover.Trigger asChild>
            <button className="performance-trigger" type="button" aria-label="查看模型性能历史" title="模型响应性能">
              <span className={`performance-signal ${responseMetrics ? performanceGrade(responseMetrics) : "unknown"}`}><i /><i /><i /></span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="performance-popover" side="top" align="end" sideOffset={7}>
              <strong>近期请求性能</strong>
              {responseMetricsHistory.length ? (
                <>
                  <div className="performance-grid">{responseMetricsHistory.slice(-60).map((item, index) => {
                    const cache = summarizeCacheUsage(item.inputTokens, item.cacheReadTokens, item.cacheWriteTokens);
                    const reportsCache = (item.cacheReadTokens ?? 0) > 0 || (item.cacheWriteTokens ?? 0) > 0;
                    return <span className={`performance-cell ${performanceGrade(item)}`} key={`${item.timestamp}-${index}`}><span className="performance-tooltip"><strong>{new Date(item.timestamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</strong>{item.firstTokenMs === undefined ? null : <span>首字 {formatMetricDuration(item.firstTokenMs)}</span>}{item.averageTokensPerSecond === undefined ? null : <span>{item.averageTokensPerSecond.toFixed(1)} tok/s</span>}{item.outputTokens === undefined ? null : <span>输出 {formatTokens(item.outputTokens)} tok</span>}{cache.promptTokens ? <span>输入 {formatTokens(cache.promptTokens)} tok</span> : null}{reportsCache ? <span>未缓存 {formatTokens(cache.uncachedTokens)}</span> : null}{item.cacheReadTokens === undefined ? null : <span>缓存读取 {formatTokens(item.cacheReadTokens)}</span>}{item.cacheWriteTokens === undefined ? null : <span>缓存写入 {formatTokens(item.cacheWriteTokens)}</span>}{reportsCache && cache.hitRate !== undefined ? <span>缓存命中 {(cache.hitRate * 100).toFixed(1)}%</span> : null}</span></span>;
                  })}</div>
                  <div className="performance-legend"><span>较慢</span><i className="slow" /><i className="fair" /><i className="good" /><i className="excellent" /><span>较快</span></div>
                </>
              ) : <p>完成一次模型请求后，这里会显示性能记录。</p>}
              <Popover.Arrow className="model-popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root> : null}
        <Popover.Root>
          <Popover.Trigger asChild>
            <button className="context-trigger" type="button" aria-label="查看上下文 Token 详情" title={`上下文 ${contextUsage?.percent === null || contextUsage?.percent === undefined ? "未知" : `${contextUsage.percent.toFixed(1)}%`}`}>
              <span className="context-ring" style={{ "--context-percent": `${percent}%` } as CSSProperties}><i /></span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="context-popover" side="top" align="end" sideOffset={7}>
              <strong>Token 使用情况</strong>
              <dl>
                <div><dt>已占用</dt><dd>{formatTokens(contextUsage?.tokens)} / {formatTokens(contextUsage?.contextWindow)}</dd></div>
                <div><dt>占用比例</dt><dd>{contextUsage?.percent === null || contextUsage?.percent === undefined ? "—" : `${contextUsage.percent.toFixed(1)}%`}</dd></div>
                {tokenBreakdown ? <>
                  <div><dt>系统提示词</dt><dd>{formatTokens(tokenBreakdown.systemPrompt)}</dd></div>
                  <div><dt>历史消息</dt><dd>{formatTokens(tokenBreakdown.history)}</dd></div>
                  <div><dt>用户提示词</dt><dd>{formatTokens(tokenBreakdown.userPrompt)}</dd></div>
                  <div><dt>工具定义注入</dt><dd>{formatTokens(tokenBreakdown.toolDefinitions)}</dd></div>
                  <div><dt>MCP 定义注入</dt><dd>{formatTokens(tokenBreakdown.mcpDefinitions)}</dd></div>
                  <div><dt>工具结果</dt><dd>{formatTokens(tokenBreakdown.toolResults)}</dd></div>
                  <div><dt>MCP 结果</dt><dd>{formatTokens(tokenBreakdown.mcpResults)}</dd></div>
                </> : null}
                {/*
                  The one number from the billing side worth keeping here: the
                  rest of the context is what this turn costs, and this says how
                  much of it is being re-sent at full price.
                */}
                {tokenUsage ? (
                  <div><dt>缓存命中率</dt><dd>{cumulativeCache.hitRate === undefined ? "—" : `${(cumulativeCache.hitRate * 100).toFixed(1)}%`}</dd></div>
                ) : null}
              </dl>
              {tokenUsage ? (
                <p className="context-popover-note">缓存命中率按本会话累计的输入统计；长期为 0 说明每一轮都在按全价重发整个上下文。</p>
              ) : null}
              <Popover.Arrow className="model-popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  );
}
