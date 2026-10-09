import { createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelProviderQuotaResult, ModelProviderQuotaWindow } from "@coilcoil/runtime-protocol";

// Endpoint/header and window conventions adapted from Router-For.ME's CPA
// management panel. See docs/third-party/subscription-quota.md (MIT notice).
const ENDPOINTS = {
  anthropic: "https://api.anthropic.com/api/oauth/usage",
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
} as const;
const CACHE_MS = 60_000;
const TIMEOUT_MS = 15_000;
type QuotaProvider = keyof typeof ENDPOINTS;
type AuthRuntime = Pick<ModelRuntime, "checkAuth" | "getAuth">;
interface CacheEntry {
  identity: string;
  pending?: Promise<ModelProviderQuotaResult>;
  result?: ModelProviderQuotaResult;
}
const caches = new WeakMap<AuthRuntime, Map<string, CacheEntry>>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value: unknown): number | null {
  const parsed = number(value);
  return parsed === null || parsed < 0 ? null : parsed;
}

function instant(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = number(value);
  const ms = numeric === null ? typeof value === "string" ? Date.parse(value) : NaN
    : numeric < 1e12 ? numeric * 1000 : numeric;
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : null;
}

function window(id: string, label: string, value: unknown, kind: QuotaProvider, now: number): ModelProviderQuotaWindow {
  const data = record(value);
  let resetsAt = instant(kind === "anthropic" ? data?.resets_at : data?.reset_at ?? data?.resetAt);
  if (kind === "openai-codex" && resetsAt === null) {
    const offset = number(data?.reset_after_seconds ?? data?.resetAfterSeconds);
    if (offset !== null && offset >= 0 && offset <= 31 * 86400) resetsAt = now + offset * 1000;
  }
  return { id, label, usedPercent: percent(kind === "anthropic" ? data?.utilization : data?.used_percent ?? data?.usedPercent), resetsAt };
}

export function parseSubscriptionQuota(provider: QuotaProvider, payload: unknown, now = Date.now()): ModelProviderQuotaResult {
  const data = record(payload);
  if (!data) throw new Error("Invalid quota payload");
  const windows: ModelProviderQuotaWindow[] = [];
  if (provider === "anthropic") {
    if (!("five_hour" in data) && !("seven_day" in data)) throw new Error("Missing quota windows");
    windows.push(window("five_hour", "5 小时限制", data.five_hour, provider, now));
    windows.push(window("weekly", "周限制", data.seven_day, provider, now));
    for (const [key, label] of [["seven_day_sonnet", "Sonnet 周限制"], ["seven_day_opus", "Opus 周限制"]] as const) {
      if (record(data[key])) windows.push(window(key, label, data[key], provider, now));
    }
  } else {
    const rate = record(data.rate_limit ?? data.rateLimit);
    if (!rate) throw new Error("Missing quota windows");
    const primary = record(rate.primary_window ?? rate.primaryWindow);
    const secondary = record(rate.secondary_window ?? rate.secondaryWindow);
    let fiveHour: Record<string, unknown> | undefined;
    let weekly: Record<string, unknown> | undefined;
    const others: ModelProviderQuotaWindow[] = [];
    for (const [index, raw] of [primary, secondary].entries()) {
      if (!raw) continue;
      const seconds = number(raw.limit_window_seconds ?? raw.limitWindowSeconds);
      if (seconds === 18000) fiveHour = raw;
      else if (seconds === 604800) weekly = raw;
      else {
        const monthly = seconds !== null && seconds >= 28 * 86400 && seconds <= 31 * 86400;
        const label = monthly ? "月限制" : seconds !== null && seconds > 0 ? `${Math.round(seconds / 3600)} 小时限制` : index === 0 ? "主窗口限制（周期未提供）" : "次窗口限制（周期未提供）";
        others.push(window(`window_${index}`, label, raw, provider, now));
      }
    }
    windows.push(window("five_hour", "5 小时限制", fiveHour, provider, now));
    windows.push(window("weekly", "周限制", weekly, provider, now));
    windows.push(...others);
  }
  const plan = data.plan_type ?? data.planType;
  return {
    provider, status: "ok", windows, updatedAt: now,
    ...(typeof plan === "string" && /^[a-z0-9_-]{1,40}$/i.test(plan) ? { plan } : {}),
  };
}

function accountId(token: string): string | undefined {
  try {
    const claims = record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    const id = record(claims?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof id === "string" && /^[\w-]{1,200}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

function failure(provider: string, status: ModelProviderQuotaResult["status"], message: string): ModelProviderQuotaResult {
  return { provider, status, windows: [], updatedAt: Date.now(), message };
}

async function requestQuota(provider: QuotaProvider, token: string, signal: AbortSignal): Promise<ModelProviderQuotaResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (provider === "anthropic") {
    headers["anthropic-beta"] = "oauth-2025-04-20";
    headers["User-Agent"] = "claude-cli/2.1.280 (external, cli)";
  } else {
    const id = accountId(token);
    if (!id) return failure(provider, "error", "Codex 登录中缺少账号信息，请重新订阅登录。");
    headers["Chatgpt-Account-Id"] = id;
    headers["User-Agent"] = "codex-tui/0.149.1 (Mac OS 26.5.2; arm64)";
  }
  try {
    // A configured model proxy must never receive the subscription token.
    const response = await fetch(ENDPOINTS[provider], { headers, signal, redirect: "error" });
    if (!response.ok) {
      // Do not echo upstream bodies or auth errors: they can contain credentials.
      if (response.status === 401) return failure(provider, "error", "订阅授权已失效，请重新订阅登录。");
      if (response.status === 403) return failure(provider, "error", "当前授权无法查询额度，请重新订阅登录或稍后重试。");
      if (response.status === 429) return failure(provider, "error", "额度查询过于频繁，请稍后刷新。");
      return failure(provider, "error", `额度服务暂时不可用（HTTP ${response.status}），请稍后刷新。`);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { return failure(provider, "error", "额度服务返回了无法识别的数据，请稍后刷新。"); }
    try { return parseSubscriptionQuota(provider, payload); }
    catch { return failure(provider, "error", "额度服务未返回可识别的限制信息，请稍后刷新。"); }
  } catch {
    return failure(provider, "error", signal.aborted ? "额度查询超时，请稍后刷新。" : "无法连接额度服务，请检查网络后刷新。");
  }
}

/** Uses the existing auth resolver/refresh lock; quota failures never log out. */
export async function querySubscriptionQuota(runtime: AuthRuntime, provider: string, refresh = false): Promise<ModelProviderQuotaResult> {
  if (provider !== "anthropic" && provider !== "openai-codex") return failure(provider, "unsupported", "此服务商暂不支持订阅额度查询。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    if ((await runtime.checkAuth(provider, { signal: controller.signal }))?.type !== "oauth") {
      caches.get(runtime)?.delete(provider);
      return failure(provider, "not_logged_in", "订阅登录后可查看账号额度；API 密钥不使用订阅额度。");
    }
    const auth = await runtime.getAuth(provider, { signal: controller.signal });
    const token = auth?.auth.apiKey;
    if (!token || auth.source !== "OAuth") {
      caches.get(runtime)?.delete(provider);
      return failure(provider, "not_logged_in", "请先完成订阅登录，再查询额度。");
    }
    // Account/token changes cannot reuse the previous account's cached usage.
    const identity = createHash("sha256").update(token).digest("hex");
    const cache = caches.get(runtime) ?? new Map<string, CacheEntry>();
    caches.set(runtime, cache);
    const previous = cache.get(provider);
    if (previous?.identity === identity) {
      if (previous.pending) return await previous.pending;
      if (!refresh && previous.result && Date.now() - previous.result.updatedAt < CACHE_MS) return previous.result;
    }
    const entry: CacheEntry = { identity };
    entry.pending = requestQuota(provider, token, controller.signal);
    cache.set(provider, entry);
    const result = await entry.pending;
    if (cache.get(provider) === entry) {
      if (result.status === "ok") cache.set(provider, { identity, result });
      else cache.delete(provider);
    }
    return result;
  } catch {
    return failure(provider, "error", controller.signal.aborted ? "额度查询超时，请稍后刷新。" : "无法读取订阅授权，请稍后重试；若持续失败，请重新订阅登录。");
  } finally { clearTimeout(timer); }
}
