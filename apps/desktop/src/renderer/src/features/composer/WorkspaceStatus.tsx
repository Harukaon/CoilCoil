import * as Popover from "@radix-ui/react-popover";
import { FileCode2 } from "lucide-react";
import { useState } from "react";
import type { CSSProperties } from "react";
import type { ContextUsage, ProjectSelection, ResponseMetrics, TokenUsage } from "@suocode/runtime-protocol";

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
}: {
  project: ProjectSelection | null;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  contextUsage?: ContextUsage;
  tokenUsage: TokenUsage;
}): React.JSX.Element {
  const [pathOpen, setPathOpen] = useState(false);
  const percent = Math.max(0, Math.min(100, contextUsage?.percent ?? 0));
  const firstTokenText = responseMetrics?.firstTokenMs === undefined ? undefined : `首字 ${formatMetricDuration(responseMetrics.firstTokenMs)}`;
  const speedText = responseMetrics?.averageTokensPerSecond === undefined ? undefined : `${responseMetrics.averageTokensPerSecond.toFixed(1)} tok/s`;
  const metricSummary = [firstTokenText, speedText].filter(Boolean).join(" · ");
  const hasPerformanceHistory = responseMetricsHistory.length > 0;
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
                    const promptTokens = (item.inputTokens ?? 0) + (item.cacheReadTokens ?? 0) + (item.cacheWriteTokens ?? 0);
                    const cacheRate = promptTokens > 0 ? ((item.cacheReadTokens ?? 0) / promptTokens) * 100 : undefined;
                    return <span className={`performance-cell ${performanceGrade(item)}`} key={`${item.timestamp}-${index}`}><span className="performance-tooltip"><strong>{new Date(item.timestamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</strong>{item.firstTokenMs === undefined ? null : <span>首字 {formatMetricDuration(item.firstTokenMs)}</span>}{item.averageTokensPerSecond === undefined ? null : <span>{item.averageTokensPerSecond.toFixed(1)} tok/s</span>}{item.outputTokens === undefined ? null : <span>输出 {formatTokens(item.outputTokens)} tok</span>}{item.cacheReadTokens === undefined ? null : <span>缓存读取 {formatTokens(item.cacheReadTokens)}</span>}{item.cacheWriteTokens === undefined ? null : <span>缓存写入 {formatTokens(item.cacheWriteTokens)}</span>}{cacheRate === undefined ? null : <span>缓存命中 {cacheRate.toFixed(1)}%</span>}</span></span>;
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
                <div><dt>当前上下文</dt><dd>{formatTokens(contextUsage?.tokens)} / {formatTokens(contextUsage?.contextWindow)}</dd></div>
                <div><dt>上下文占用</dt><dd>{contextUsage?.percent === null || contextUsage?.percent === undefined ? "—" : `${contextUsage.percent.toFixed(1)}%`}</dd></div>
                <div><dt>累计输入</dt><dd>{formatTokens(tokenUsage.input)}</dd></div>
                <div><dt>累计输出</dt><dd>{formatTokens(tokenUsage.output)}</dd></div>
                <div><dt>缓存读取</dt><dd>{formatTokens(tokenUsage.cacheRead)}</dd></div>
                <div><dt>本次输出</dt><dd>{formatTokens(responseMetrics?.outputTokens)}</dd></div>
              </dl>
              <Popover.Arrow className="model-popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  );
}
