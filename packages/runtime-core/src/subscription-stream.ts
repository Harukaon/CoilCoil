import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type Api,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/** Keep the built-in API's identity local. Other accounts remain foreign: their opaque reasoning is not reusable here. */
export function subscriptionTranscript(context: TranscriptContext, accountId: string, builtinId: string): TranscriptContext {
  return {
    ...context,
    messages: context.messages.map((message) => message.role === "assistant" && message.provider === accountId
      ? { ...message, provider: builtinId }
      : message),
  };
}

/** Clone events rather than mutating the source: Codex also caches its output. */
export function subscriptionStream(source: AssistantMessageEventStream, accountId: string, model: Model<Api>, signal?: AbortSignal): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  let last: AssistantMessage | undefined;
  void (async () => {
    try {
      for await (const event of source) {
        let mapped: AssistantMessageEvent;
        if (event.type === "done") {
          last = { ...event.message, provider: accountId };
          mapped = { ...event, message: last };
        } else if (event.type === "error") {
          last = { ...event.error, provider: accountId };
          mapped = { ...event, error: last };
        } else {
          last = { ...event.partial, provider: accountId };
          mapped = { ...event, partial: last };
        }
        output.push(mapped);
      }
      output.end({ ...await source.result(), provider: accountId });
    } catch (error) {
      const aborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
      const failure: AssistantMessage = {
        ...(last ?? {
          role: "assistant", api: model.api, model: model.id, content: [], timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }),
        provider: accountId, stopReason: aborted ? "aborted" : "error", errorMessage: aborted ? "订阅模型请求已取消。" : "订阅模型请求失败，请重试。",
      };
      output.push({ type: "error", reason: aborted ? "aborted" : "error", error: failure });
      output.end(failure);
    }
  })();
  return output;
}
