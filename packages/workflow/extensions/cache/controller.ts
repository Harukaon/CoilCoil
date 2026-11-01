import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream,
  type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { PromptCacheLedger, type CacheLedgerState, type CacheRecord } from "#cache/ledger";
import { type CachePurpose, type WirePlan, hash, object, planCache } from "#cache/wire";
import { anthropicCacheRetention } from "#cache/retention";

export interface PendingCacheRequest { plan?: WirePlan; startedAt?: number; diagnostic?: string; transportHash?: string;
  credential?: string; rejected?: string }
export const CACHE_CONTROLLER_REQUEST = "coilcoil:cache-controller:v1";

export function requestCacheController(events: { emit(channel: string, data: unknown): void }): AnthropicCacheController | undefined {
  const request: { controller?: AnthropicCacheController } = {};
  events.emit(CACHE_CONTROLLER_REQUEST, request);
  return request.controller;
}

/** One controller belongs to one session, including its auxiliary summary requests. */
export class AnthropicCacheController {
  readonly ledger: PromptCacheLedger;
  private diagnosticsUnsupported = false;
  private diagnosticsEnabled = false;
  private acceptedCredential?: { at: number; responseId?: string; value: string };
  private readonly publish?: (state: CacheLedgerState, record: CacheRecord) => void;

  constructor(saved?: unknown, publish?: (state: CacheLedgerState, record: CacheRecord) => void) {
    this.ledger = new PromptCacheLedger(saved);
    this.publish = publish;
  }

  options(model: Model<Api>, input: SimpleStreamOptions | undefined, purpose: CachePurpose,
    features: { diagnostics?: boolean; requireParent?: boolean } = {}): {
    options: SimpleStreamOptions; pending: PendingCacheRequest;
  } {
    const pending: PendingCacheRequest = {};
    if (features.diagnostics !== undefined) this.diagnosticsEnabled = features.diagnostics;
    const diagnosticsEnabled = this.diagnosticsEnabled;
    const requireParent = (plan: WirePlan | undefined): void => {
      if (!features.requireParent) return;
      const baseline = this.ledger.state.baseline;
      const parent = baseline?.boundary;
      const point = this.ledger.state.points.find((entry) => entry.hash === parent?.hash);
      const now = Date.now();
      if (!plan?.parentHit || plan.preservedPolicy || !baseline?.shareable || !parent
        || plan.boundary?.hash !== parent.hash || !point || now < point.at || now - point.at >= point.ttl - 10_000) {
        pending.rejected = "prefix mismatch: summary cannot replay the accepted parent request";
        throw new Error(pending.rejected);
      }
    };
    const compat = (model as Model<"anthropic-messages">).compat;
    const requested = anthropicCacheRetention(model.api, false, input);
    const retention = requested === "long" && compat?.supportsLongCacheRetention === false ? "short" : requested;
    const ttl = retention === "none" ? 0 : retention === "long" ? 3_600_000 : 300_000;
    // Credentials rotate without changing the cache namespace. Only explicit routing identity belongs here.
    const routing = Object.fromEntries(Object.entries(input?.headers ?? {}).filter(([key]) =>
      ["anthropic-workspace-id", "anthropic-organization-id"].includes(key.toLowerCase())));
    const scope = hash([model.provider, model.baseUrl, routing]);
    const parameterHeaders = Object.fromEntries(Object.entries(input?.headers ?? {})
      .filter(([key]) => ["anthropic-beta", "anthropic-version"].includes(key.toLowerCase())));
    let official = false;
    try { official = new URL(model.baseUrl).hostname === "api.anthropic.com"; } catch { /* custom endpoint */ }
    const options: SimpleStreamOptions = {
      ...input,
      ...(retention === undefined ? {} : { cacheRetention: retention }),
      onPayload: async (payload, selected) => {
        const projected = await input?.onPayload?.(payload, selected) ?? payload;
        const plan = planCache(projected, scope, ttl, purpose, this.ledger.state.points, Date.now(), {
          tools: compat?.supportsCacheControlOnTools !== false, parameters: parameterHeaders,
        });
        requireParent(plan);
        if (!plan) return projected;
        pending.plan = plan;
        // TTL starts at request dispatch, never at the end of prefill/TTFT.
        pending.startedAt = Date.now();
        if (official && diagnosticsEnabled && !this.diagnosticsUnsupported && !plan.payload.diagnostics) {
          plan.payload.diagnostics = { previous_message_id: this.ledger.state.baseline?.record.responseId ?? null };
        }
        return plan.payload;
      },
      onProviderStreamEvent: async (event, selected) => {
        await input?.onProviderStreamEvent?.(event, selected);
        if (object(event) && event.type === "message_start" && object(event.message)) {
          const diagnostics = event.message.diagnostics;
          if (object(diagnostics) && object(diagnostics.cache_miss_reason) && typeof diagnostics.cache_miss_reason.type === "string") {
            const reason = diagnostics.cache_miss_reason.type;
            pending.diagnostic = ["model_changed", "system_changed", "tools_changed", "messages_changed", "previous_message_not_found", "unavailable"]
              .includes(reason) ? reason : "unavailable";
          }
        }
      },
    };
    {
      const fetch = input?.fetch ?? globalThis.fetch;
      options.fetch = async (url, init) => {
        // Payload hooks, request queues and SDK retry delays all consume TTL.
        // Recheck immediately before each dispatch, including optional-field fallback.
        requireParent(pending.plan);
        const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
        const authorization = headers.get("authorization");
        // OAuth access tokens rotate within a stable account alias. API keys and
        // arbitrary bearer credentials can move the same provider to another workspace.
        const credential = hash(authorization?.startsWith("Bearer sk-ant-oat")
          ? ["oauth", model.provider] : [headers.get("x-api-key"), authorization]);
        const baseline = this.ledger.state.baseline?.record;
        if (features.requireParent && (!this.acceptedCredential || this.acceptedCredential.at !== baseline?.at
          || this.acceptedCredential.responseId !== baseline?.responseId || this.acceptedCredential.value !== credential)) {
          pending.rejected = "prefix mismatch: summary credentials differ from the accepted parent request";
          throw new Error(pending.rejected);
        }
        pending.credential = credential;
        const route = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        const transportHash = hash([route, ...["anthropic-version", "anthropic-workspace-id", "anthropic-organization-id", "anthropic-beta"]
          .map((name) => [name, name === "anthropic-beta" ? headers.get(name)?.split(",").map((value) => value.trim()).sort() : headers.get(name)])]);
        const previous = this.ledger.state.baseline?.record.transportHash;
        if (features.requireParent && previous && previous !== transportHash) {
          pending.rejected = "prefix mismatch: summary routing or beta headers changed";
          throw new Error(pending.rejected);
        }
        pending.transportHash = transportHash;
        const dispatchedAt = Date.now();
        const response = await fetch(url, init);
        if (response.ok) pending.startedAt = dispatchedAt;
        // A rejected optional diagnostic field must not break subscription or older API routes.
        if (!official || response.status !== 400 || typeof init?.body !== "string") return response;
        let body: unknown;
        try { body = JSON.parse(init.body); } catch { return response; }
        if (!object(body) || !body.diagnostics) return response;
        let error = "";
        try { error = await response.clone().text(); } catch { return response; }
        if (!/diagnostics/i.test(error) || !/extra|unknown|unexpected|unsupported|not (?:permitted|allowed|supported)|unrecognized/i.test(error)) return response;
        this.diagnosticsUnsupported = true;
        delete body.diagnostics;
        return options.fetch!(url, { ...init, body: JSON.stringify(body) });
      };
    }
    return { options, pending };
  }

  observe(source: AssistantMessageEventStream | Promise<AssistantMessageEventStream>, pending: PendingCacheRequest,
    purpose: CachePurpose): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const stream = await source;
      let completed = false;
      for await (const event of stream) {
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          // SDK fetch errors are wrapped as "Connection error". Retain our
          // local rejection so the summary layer does not retry it as a network failure.
          if (pending.rejected && event.type === "error") message.errorMessage = pending.rejected;
          this.complete(pending, purpose, message);
          completed = true;
        }
        output.push(event);
      }
      const final = await stream.result();
      if (pending.rejected && final.stopReason === "error") final.errorMessage = pending.rejected;
      if (!completed) this.complete(pending, purpose, final);
      output.end(final);
    })().catch((error: unknown) => {
      // Provider streams normally encode errors. Preserve that contract for a throwing custom stream too.
      const message: AssistantMessage = { role: "assistant", content: [], api: "anthropic-messages", provider: "unknown",
        model: pending.plan?.fingerprint.model ?? "unknown", timestamp: Date.now(), stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      output.push({ type: "error", reason: "error", error: message });
      output.end(message);
    });
    return output;
  }

  private complete(pending: PendingCacheRequest, purpose: CachePurpose, message: AssistantMessage): void {
    if (!pending.plan || (!message.responseId && message.usage.cacheRead + message.usage.cacheWrite === 0)) return;
    // Telemetry/persistence is best effort and never changes a valid model response.
    try {
      const previousTransport = this.ledger.state.baseline?.record.transportHash;
      const record = this.ledger.complete(pending.plan, purpose, message.usage, message.responseId,
        pending.diagnostic, pending.startedAt ?? Date.now());
      record.transportHash = pending.transportHash;
      if (this.ledger.state.baseline?.record === record && pending.credential) {
        this.acceptedCredential = { at: record.at, responseId: record.responseId, value: pending.credential };
      }
      if (previousTransport && pending.transportHash && previousTransport !== pending.transportHash
        && (record.reason === "hit" || record.reason === "unknown")) record.reason = "parameters_changed";
      this.publish?.(structuredClone(this.ledger.state), record);
    } catch { /* cache diagnostics cannot fail the agent */ }
  }
}
