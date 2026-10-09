export function quotaPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "服务商未提供" : `${Number(value.toFixed(1))}%`;
}

export function quotaResetLabel(resetsAt: number | null, now = Date.now()): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return "服务商未提供重置时间";
  if (resetsAt <= now) return "已到重置时间，请刷新查看";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const remainder = minutes % 60;
  const duration = days ? `${days} 天${hours ? ` ${hours} 小时` : ""}` : hours ? `${hours} 小时${remainder ? ` ${remainder} 分钟` : ""}` : `${minutes} 分钟`;
  const date = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(resetsAt);
  return `${duration}后重置 · ${date}`;
}

export function quotaPlanLabel(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  const names: Record<string, string> = { free: "Free", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise" };
  return names[plan.toLowerCase()] ?? plan;
}
