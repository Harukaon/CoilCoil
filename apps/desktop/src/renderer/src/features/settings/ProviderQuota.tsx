import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelProviderQuotaResult, SubscriptionProvider } from "@coilcoil/runtime-protocol";
import { quotaPercent, quotaPlanLabel, quotaResetLabel } from "./providerQuotaPresentation";
import "./providerQuota.css";

export function ProviderQuota({ provider, subscriptionProvider, loggedIn, runtimeId }: {
  provider: string;
  subscriptionProvider?: SubscriptionProvider;
  loggedIn: boolean;
  runtimeId?: string;
}): React.JSX.Element | null {
  const supported = subscriptionProvider !== undefined || provider === "anthropic" || provider === "openai-codex";
  const [quota, setQuota] = useState<ModelProviderQuotaResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sequence = useRef(0);
  const load = useCallback(async (refresh = false) => {
    const current = ++sequence.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await window.coilcoil.request<ModelProviderQuotaResult>({ type: "get_model_provider_quota", provider, refresh }, runtimeId);
      if (sequence.current !== current) return;
      setNow(Date.now());
      if (result.status === "ok") setQuota(result);
      else {
        if (result.status === "not_logged_in" || result.status === "unsupported") setQuota(undefined);
        setError(result.message ?? "暂时无法查询额度，请稍后刷新。");
      }
    } catch {
      if (sequence.current === current) setError("额度查询失败，请稍后刷新。");
    } finally {
      if (sequence.current === current) setLoading(false);
    }
  }, [provider, runtimeId]);

  useEffect(() => {
    setQuota(undefined);
    setError(undefined);
    setLoading(false);
    if (supported && loggedIn) void load();
    return () => { ++sequence.current; };
  }, [load, supported, loggedIn]);

  useEffect(() => {
    if (!loggedIn || !quota) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [loggedIn, quota]);

  if (!supported) return null;
  const plan = quotaPlanLabel(quota?.plan);
  return <section className="provider-quota" aria-label="订阅额度" aria-busy={loading}>
    <div className="provider-quota-heading">
      <div><strong>订阅额度</strong>{loggedIn && plan ? <span>{plan}</span> : null}</div>
      {loggedIn ? <button className="provider-quota-refresh" type="button" disabled={loading} onClick={() => { void load(true); }} aria-label="刷新订阅额度">
        {loading ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}{loading ? "查询中" : "刷新"}
      </button> : null}
    </div>
    {!loggedIn ? <p className="provider-quota-note">订阅登录后可查看 5 小时和周额度；API 密钥不使用订阅额度。</p> : <>
      {error ? <p className="provider-quota-error" role="status">{error}{quota ? " 下方为上次成功查询的数据。" : ""}</p> : null}
      {quota ? <div className="provider-quota-windows" data-stale={Boolean(error)}>{quota.windows.map((item) => {
        const used = item.usedPercent;
        const known = used !== null && Number.isFinite(used);
        const tone = known && used >= 100 ? "exhausted" : known && used >= 80 ? "high" : "normal";
        return <div className={`provider-quota-window ${tone}`} data-window-id={item.id} key={item.id}>
          <div className="provider-quota-window-heading"><span>{item.label}</span><strong>{known ? `已用 ${quotaPercent(used)}` : "服务商未提供用量"}</strong></div>
          <div className="provider-quota-track" role="progressbar" aria-label={item.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.max(0, Math.min(100, used)) : undefined} aria-valuetext={known ? `已用 ${quotaPercent(used)}` : "服务商未提供用量"}>
            {known ? <span style={{ width: `${Math.max(0, Math.min(100, used))}%` }} /> : null}
          </div>
          <small>{quotaResetLabel(item.resetsAt, now)}</small>
        </div>;
      })}</div> : !error ? <p className="provider-quota-note" role="status">正在读取账号额度…</p> : null}
      {quota ? <p className="provider-quota-note">官方账号用量 · {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(quota.updatedAt)} 更新{error ? "（非最新）" : ""}</p> : null}
    </>}
  </section>;
}
