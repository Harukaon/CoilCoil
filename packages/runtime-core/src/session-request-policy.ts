import type { AgentSession, EventBusController, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DiagnosticLog } from "@coilcoil/diagnostics";
import type { Model } from "@earendil-works/pi-ai";
import { anthropicCacheRetention, type CachedSessionRequest } from "@coilcoil/workflow/extensions/anthropic-cache-policy.js";
import { AnthropicCacheController, CACHE_CONTROLLER_REQUEST } from "@coilcoil/workflow/extensions/cache/controller.js";
import { CACHE_LEDGER_ENTRY, cacheLedgerCheckpoint, type CacheLedgerState, restoreCacheLedger } from "@coilcoil/workflow/extensions/cache/ledger.js";

const controllers = new WeakMap<object, AnthropicCacheController>();

export function expectCacheChange(session: object, reason: "user_tools_changed" | "user_rewind"): void {
  controllers.get(session)?.ledger.expect(reason);
}

export function sessionCacheLedger(session: object): CacheLedgerState | undefined {
  return controllers.get(session)?.ledger.state;
}

/** Apply before Pi's stream wrapper so its cache warmer sees the same TTL as the provider. */
export function installSessionRequestPolicy(
  session: Pick<AgentSession, "agent" | "sessionId"> & Partial<Pick<AgentSession, "sessionManager">>,
  runtime: Pick<ModelRuntime, "isUsingSubscription">,
  onRequest?: (request: CachedSessionRequest | undefined) => void,
  log?: Pick<DiagnosticLog, "info">,
  events?: Pick<EventBusController, "on">,
): void {
  const branch = () => session.sessionManager?.getBranch() ?? [];
  const controller = new AnthropicCacheController(restoreCacheLedger(branch()), (state, record) => {
    session.sessionManager?.appendCustomEntry(CACHE_LEDGER_ENTRY, cacheLedgerCheckpoint(state));
    log?.info("cache", "request", { ...record }, { sessionPath: session.sessionManager?.getSessionFile() ?? undefined });
  });
  controllers.set(session, controller);
  events?.on(CACHE_CONTROLLER_REQUEST, (request) => {
    if (request && typeof request === "object") (request as { controller?: AnthropicCacheController }).controller = controller;
  });
  let lastCompaction = branch().filter((entry) => entry.type === "compaction").at(-1)?.id;
  let lastAnchor: string | undefined;
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    const main = options?.sessionId === session.sessionId;
    const entries = branch();
    if (main) {
      const compaction = entries.filter((entry) => entry.type === "compaction").at(-1)?.id;
      if (compaction && compaction !== lastCompaction) controller.ledger.expect("compaction");
      else if (lastAnchor && !entries.some((entry) => entry.id === lastAnchor)) {
        controller.ledger.expect("user_rewind");
        const points = restoreCacheLedger(entries)?.points ?? [];
        const merged = new Map(controller.ledger.state.points.map((point) => [point.hash, point]));
        for (const point of points) {
          if (point.at >= (merged.get(point.hash)?.at ?? -1)) merged.set(point.hash, point);
        }
        controller.ledger.state.points = [...merged.values()].sort((left, right) => left.at - right.at).slice(-32);
      }
      lastCompaction = compaction;
      lastAnchor = entries.at(-1)?.id;
    }
    const requested = main ? anthropicCacheRetention(model.api, model.api === "anthropic-messages" && runtime.isUsingSubscription(model.provider), options)
      : options?.cacheRetention;
    const cacheRetention = requested === "long" && model.api === "anthropic-messages"
      && (model as Model<"anthropic-messages">).compat?.supportsLongCacheRetention === false ? "short" : requested;
    if (main) onRequest?.(model.api === "anthropic-messages" ? {
      model: { provider: model.provider, id: model.id, api: model.api },
      context: { ...context, messages: [...context.messages] },
      cacheRetention: cacheRetention ?? "short",
      at: Date.now(),
      cache: controller,
    } : undefined);
    const configured = cacheRetention === undefined ? options : { ...options, cacheRetention };
    if (model.api !== "anthropic-messages") return stream(model, context, configured);
    const purpose = main ? "conversation" : "branch_summary";
    const prepared = controller.options(model, configured, purpose, { diagnostics: !runtime.isUsingSubscription(model.provider) });
    return controller.observe(stream(model, context, prepared.options), prepared.pending, purpose);
  };
}
