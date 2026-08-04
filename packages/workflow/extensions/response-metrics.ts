import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";

interface ResponseTiming {
  requestStartedAt: number;
  firstTokenAt?: number;
}

interface ConversationTiming {
  startedAt: number;
}

function formatSeconds(milliseconds: number): string {
  return (Math.max(0, milliseconds) / 1_000).toFixed(2);
}

export function formatTurnDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(2)}s`;

  const totalWholeSeconds = Math.round(totalSeconds);
  const seconds = totalWholeSeconds % 60;
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m${seconds}s`;

  const roundedMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return `${hours}h${minutes}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

function isTokenDelta(type: string, delta: unknown): boolean {
  return (
    (type === "text_delta" ||
      type === "thinking_delta" ||
      type === "toolcall_delta") &&
    typeof delta === "string" &&
    delta.length > 0
  );
}

export default function responseMetricsExtension(pi: ExtensionAPI): void {
  let current: ResponseTiming | undefined;
  let conversation: ConversationTiming | undefined;
  let lastResponseMetrics: string | undefined;

  pi.on("before_agent_start", () => {
    conversation = { startedAt: performance.now() };
    lastResponseMetrics = undefined;
  });

  pi.on("before_provider_request", () => {
    current = { requestStartedAt: performance.now() };
  });

  pi.on("message_update", (event) => {
    if (!current || current.firstTokenAt !== undefined) return;
    const streamEvent = event.assistantMessageEvent;
    const delta = "delta" in streamEvent ? streamEvent.delta : undefined;
    if (isTokenDelta(streamEvent.type, delta)) {
      current.firstTokenAt = performance.now();
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !current) return;

    const endedAt = performance.now();
    const outputTokens = event.message.usage.output;
    const firstTokenAt = current.firstTokenAt;
    const totalMs = Math.max(0, endedAt - current.requestStartedAt);
    const generationMs = firstTokenAt === undefined
      ? undefined
      : Math.max(1, endedAt - firstTokenAt);
    const averageTokensPerSecond = generationMs === undefined
      ? undefined
      : outputTokens / (generationMs / 1_000);

    if (ctx.hasUI) {
      const firstToken = firstTokenAt === undefined
        ? "—"
        : `${formatSeconds(firstTokenAt - current.requestStartedAt)}s`;
      const average = averageTokensPerSecond === undefined
        ? "—"
        : `${averageTokensPerSecond.toFixed(1)}t/s`;
      lastResponseMetrics =
        `${firstToken} ${average} ${formatTokens(outputTokens)}t/${formatSeconds(totalMs)}s`;
      ctx.ui.setStatus(
        "response-metrics",
        lastResponseMetrics,
      );
    }

    current = undefined;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!conversation) return;

    const turnDuration = `轮${formatTurnDuration(
      performance.now() - conversation.startedAt,
    )}`;
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "response-metrics",
        lastResponseMetrics
          ? `${lastResponseMetrics} ${turnDuration}`
          : turnDuration,
      );
    }

    conversation = undefined;
  });

  pi.on("session_shutdown", () => {
    current = undefined;
    conversation = undefined;
    lastResponseMetrics = undefined;
  });
}
