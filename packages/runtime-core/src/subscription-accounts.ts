import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CreateSubscriptionAccountInput, SubscriptionProvider } from "@coilcoil/runtime-protocol";
import { subscriptionStream, subscriptionTranscript } from "./subscription-stream.js";

export const SUBSCRIPTION_ACCOUNTS_FILE = "subscription-accounts.json";
export interface SubscriptionAccount {
  id: string;
  provider: SubscriptionProvider;
  name: string;
}

export function validateSubscriptionAccount(input: CreateSubscriptionAccountInput): SubscriptionAccount {
  const id = typeof input?.id === "string" ? input.id.trim() : "";
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || ["constructor", "prototype", "__proto__"].includes(id)) {
    throw new Error("账号前缀需以字母或数字开头，只能含字母、数字、点、- 和 _，最多 64 个字符。");
  }
  if ((getBuiltinProviders() as string[]).includes(id) || id === "radius" || id === "openai-responses-ws") throw new Error("账号前缀不能与原有内置服务商同名，请使用例如 claude-work 的独立前缀。");
  if (input.provider !== "anthropic" && input.provider !== "openai-codex") throw new Error("请选择 Anthropic 或 OpenAI Codex 订阅。");
  if (input.name !== undefined && typeof input.name !== "string") throw new Error("显示名称必须是文字。");
  const name = input.name?.trim() || id;
  if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("显示名称不能包含控制字符，最多 80 个字符。");
  return { id, provider: input.provider, name };
}

/** Account definitions contain names/types only. Tokens stay in auth.json by ID. */
function readAccountFile(agentDir: string): { accounts: SubscriptionAccount[]; retiredIds: string[] } {
  const path = join(agentDir, SUBSCRIPTION_ACCOUNTS_FILE);
  if (!existsSync(path)) return { accounts: [], retiredIds: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.version !== 1 || !Array.isArray(value.accounts)) throw new Error("配置格式不正确。");
    const ids = new Set<string>();
    const accounts = value.accounts.map((entry: CreateSubscriptionAccountInput) => {
      const account = validateSubscriptionAccount(entry);
      if (ids.has(account.id)) throw new Error(`账号前缀“${account.id}”重复。`);
      ids.add(account.id);
      return account;
    });
    const retiredIds: unknown = value.retiredIds ?? [];
    if (!Array.isArray(retiredIds) || retiredIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id))) throw new Error("已移除账号的前缀格式不正确。");
    return { accounts, retiredIds: [...new Set(retiredIds as string[])] };
  } catch (error) {
    throw new Error(`无法读取订阅账号配置：${error instanceof Error ? error.message : "配置格式不正确。"}`);
  }
}

export function readSubscriptionAccounts(agentDir: string): SubscriptionAccount[] {
  return readAccountFile(agentDir).accounts;
}

export function retiredSubscriptionIds(agentDir: string): ReadonlySet<string> {
  return new Set(readAccountFile(agentDir).retiredIds);
}

export function writeSubscriptionAccounts(agentDir: string, accounts: readonly SubscriptionAccount[], retireIds: readonly string[] = []): void {
  const retiredIds = [...new Set([...readAccountFile(agentDir).retiredIds, ...retireIds])];
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, SUBSCRIPTION_ACCOUNTS_FILE);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, accounts, retiredIds }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  try { chmodSync(path, 0o600); } catch { /* Non-POSIX filesystems can ignore private modes. */ }
}

export function subscriptionModelName(id: string, name: string): string {
  const prefix = `${id} · `;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

/** Fresh built-in behavior, never another account's endpoint or credential. */
export function createSubscriptionProvider(account: SubscriptionAccount): Provider {
  const base: Provider = account.provider === "anthropic" ? anthropicProvider() : openaiCodexProvider();
  return {
    ...base,
    id: account.id,
    name: `${base.name} · ${account.name}`,
    // In particular, do not let an Anthropic account inherit ANTHROPIC_API_KEY.
    auth: { oauth: base.auth.oauth },
    getModels: () => base.getModels().map((model) => ({
      ...model,
      provider: account.id,
      name: subscriptionModelName(account.id, model.name),
    })),
    stream: (model, context, options) => subscriptionStream(
      base.stream({ ...model, provider: base.id }, subscriptionTranscript(context, account.id, base.id), options), account.id, model, options?.signal,
    ),
    streamSimple: (model, context, options) => subscriptionStream(
      base.streamSimple({ ...model, provider: base.id }, subscriptionTranscript(context, account.id, base.id), options), account.id, model, options?.signal,
    ),
  };
}

interface RegistrationState {
  registered: Map<string, { definition: string; provider: Provider }>;
  pending?: Promise<unknown>;
}
const states = new WeakMap<ModelRuntime, RegistrationState>();

/** Covers both freshly created and injected/shared runtimes before ready returns. */
export async function syncSubscriptionAccounts(runtime: ModelRuntime, agentDir: string): Promise<void> {
  // Auth-only unit doubles do not implement a model registry.
  if (typeof runtime.registerNativeProvider !== "function") return;
  const accounts = readSubscriptionAccounts(agentDir);
  const state: RegistrationState = states.get(runtime) ?? { registered: new Map() };
  states.set(runtime, state);
  const ids = new Set(accounts.map((account) => account.id));
  let changed = false;
  for (const id of state.registered.keys()) {
    if (ids.has(id)) continue;
    state.registered.delete(id);
    runtime.unregisterProvider(id);
    changed = true;
  }
  for (const account of accounts) {
    const definition = JSON.stringify(account);
    const previous = state.registered.get(account.id);
    if (previous?.definition === definition && runtime.getRegisteredNativeProvider(account.id) === previous.provider) continue;
    const provider = createSubscriptionProvider(account);
    state.registered.set(account.id, { definition, provider });
    runtime.registerNativeProvider(provider);
    changed = true;
  }
  if (changed) state.pending = runtime.refresh({ allowNetwork: false });
  while (state.pending) {
    const pending = state.pending;
    try { await pending; }
    finally { if (state.pending === pending) state.pending = undefined; }
  }
}

export function quotaSubscriptionProvider(agentDir: string, id: string): SubscriptionProvider | undefined {
  if (id === "anthropic" || id === "openai-codex") return id;
  return readSubscriptionAccounts(agentDir).find((account) => account.id === id)?.provider;
}
