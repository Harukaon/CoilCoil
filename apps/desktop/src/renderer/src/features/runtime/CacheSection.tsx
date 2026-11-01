import { Database } from "lucide-react";
import type { PromptCacheDiagnostics } from "@coilcoil/runtime-protocol";
import { RuntimeSection } from "./RuntimeSection";
import { tokenNumber } from "./runtimePresentation";

const reasons: Record<string, string> = {
  cold_start: "首次建立缓存", hit: "正常复用", uncached: "本次无缓存读写", model_changed: "模型变化",
  scope_changed: "提供商或路由变化", tools_changed: "工具定义变化", system_changed: "系统提示变化",
  parameters_changed: "推理或请求参数变化", messages_changed: "历史内容变化", ttl_expired: "超过缓存有效期",
  cache_policy_changed: "缓存 TTL 或 scope 变化",
  unknown: "原因待确认", compaction: "压缩后的预期重建", user_tools_changed: "用户修改工具", user_rewind: "用户回溯历史",
};
const outcomes = { cold: "冷启动", hit: "命中", miss: "意外下降", expected: "预期重建", uncached: "未缓存" };
const purposes = { conversation: "主会话", compaction: "压缩摘要", branch_summary: "分支总结" };

export function CacheSection({ value }: { value?: PromptCacheDiagnostics }): React.JSX.Element | null {
  if (!value?.requests) return null;
  const total = value.input + value.read + value.write;
  const ratio = total > 0 ? `${(value.read / total * 100).toFixed(1)}%` : "—";
  return <RuntimeSection title="提示词缓存" icon={<Database size={14} />} badge={`累计 ${ratio}`}>
    <dl className="runtime-metric-strip">
      <div><dt>请求</dt><dd>{value.requests}</dd></div>
      <div><dt>意外下降</dt><dd>{value.misses}</dd></div>
      <div><dt>预期重建</dt><dd>{value.expected}</dd></div>
      <div><dt>5 分钟写入</dt><dd>{tokenNumber(Math.max(0, value.write - value.write1h))}</dd></div>
      <div><dt>1 小时写入</dt><dd>{tokenNumber(value.write1h)}</dd></div>
    </dl>
    <p className="runtime-section-footnote">包含主会话、压缩摘要与分支总结。命中比例为读取量除以总输入；失效原因由请求变化和实际 usage 判断，缓存存活状态无法保证。</p>
    {value.recent.slice(-10).reverse().map((item, index) => <details className="runtime-summary-card" key={`${item.at}-${index}`}>
      <summary><span>{purposes[item.purpose]} · {outcomes[item.outcome]}</span><small>{new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}</small></summary>
      <div className="runtime-summary-body">
        <p>{reasons[item.reason] ?? item.reason} · {item.model}</p>
        <p>读取 {tokenNumber(item.read)} · 写入 {tokenNumber(item.write)} · 普通输入 {tokenNumber(item.input)}</p>
        <p>有效期 {item.ttl === 3_600_000 ? "1 小时" : item.ttl > 0 ? "5 分钟" : "关闭"}{item.parentPinned ? " · 已标记匹配的父边界" : ""}</p>
        {item.diagnostic ? <p>服务端诊断：{reasons[item.diagnostic] ?? item.diagnostic}</p> : null}
      </div>
    </details>)}
  </RuntimeSection>;
}
