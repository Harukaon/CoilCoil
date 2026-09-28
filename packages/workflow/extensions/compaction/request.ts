import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { InputTooLongError, type RequestSummary } from "./summarize.ts";

/**
 * 真正发一次摘要请求（第 2 层用）。
 *
 * - 低思考：摘要不需要深想。会话开着 max 时，旧做法每一段都要先想好几分钟，思考还吃掉
 *   输出额度，写到一半被截断。
 * - 卡住就断开重来：发出去以后迟迟没有任何返回（开头给得宽一点，模型要先读完一大段材料），
 *   或者中途停住不动，就主动断开，重试。以前没有这一条，服务不回话也不报错时会一直等下去。
 * - 模型说输入太长：交给上一层把这块切小，不在这里重试同样的请求。
 * - 临时错误（断线、超时、限流、5xx）：退避后重试。
 */

export interface RequestAuth {
  apiKey?: string;
  /** 值为 null 表示「删掉这个请求头」（Pi 的约定），发请求前滤掉。 */
  headers?: Record<string, string | null>;
  env?: Record<string, string>;
  baseUrl?: string;
}

function liveHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export interface StreamRequestOptions {
  model: Model<Api>;
  auth: RequestAuth;
  signal?: AbortSignal;
  /** 发出后多久没有任何返回算卡住。 */
  firstEventMs?: number;
  /** 开始返回以后，多久没有新内容算卡住。 */
  idleMs?: number;
  attempts?: number;
  onProgress?: (event: Record<string, string | number | boolean | undefined>) => void;
}

const OVERFLOW = /context.{0,40}(length|window|limit|overflow|exceed)|input.{0,40}(too long|limit|tokens|exceed)|prompt.{0,40}(too long|limit|tokens|exceed)|too many tokens|maximum context|longer than.{0,40}context|上下文.{0,10}(过长|超出|超过)/i;

export function isInputOverflow(message: string): boolean {
  return OVERFLOW.test(message);
}

function textOf(message: AssistantMessage): string {
  return message.content.map((block) => block.type === "text" ? block.text : "").join("");
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

class StalledError extends Error {}

export function createStreamRequest(options: StreamRequestOptions): RequestSummary {
  const firstEventMs = options.firstEventMs ?? 180_000;
  const idleMs = options.idleMs ?? 90_000;
  const attempts = options.attempts ?? 3;
  const model = options.auth.baseUrl ? { ...options.model, baseUrl: options.auth.baseUrl } : options.model;
  const progress = options.onProgress ?? (() => undefined);

  const once = async (system: string, prompt: string, maxTokens: number, label: string, attempt: number): Promise<AssistantMessage> => {
    const controller = new AbortController();
    const outer = options.signal;
    const relay = (): void => controller.abort(outer?.reason);
    if (outer?.aborted) relay();
    outer?.addEventListener("abort", relay, { once: true });
    let stalled = false;
    let events = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        progress({ phase: "request_stalled", label, attempt, events, waitedMs: ms });
        controller.abort(new Error("stalled"));
      }, ms);
    };
    try {
      arm(firstEventMs);
      const stream = streamSimple(model, {
        systemPrompt: system,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      }, {
        maxTokens,
        signal: controller.signal,
        apiKey: options.auth.apiKey,
        headers: liveHeaders(options.auth.headers),
        env: options.auth.env,
        cacheRetention: "none",
        ...(model.reasoning ? { reasoning: "low" as const } : {}),
      });
      for await (const _event of stream) {
        events++;
        arm(idleMs);
      }
      const response = await stream.result();
      if (stalled) throw new StalledError(`${label}：${Math.round((events ? idleMs : firstEventMs) / 1000)} 秒没有任何返回，已断开`);
      return response;
    } catch (error) {
      if (stalled) throw new StalledError(`${label}：${Math.round((events ? idleMs : firstEventMs) / 1000)} 秒没有任何返回，已断开`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener("abort", relay);
    }
  };

  return async ({ system, prompt, maxTokens, label }) => {
    let tokens = maxTokens;
    let lengthRetried = false;
    let lastError = "未知错误";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (options.signal?.aborted) throw new Error("压缩已取消");
      let response: AssistantMessage;
      try {
        response = await once(system, prompt, tokens, label, attempt);
      } catch (error) {
        if (options.signal?.aborted) throw new Error("压缩已取消");
        lastError = error instanceof Error ? error.message : String(error);
        if (isInputOverflow(lastError)) throw new InputTooLongError(lastError);
        progress({ phase: "request_retry", label, attempt, error: lastError.slice(0, 300) });
        await sleep(2000 * attempt, options.signal);
        continue;
      }
      if (response.stopReason === "aborted" && options.signal?.aborted) throw new Error("压缩已取消");
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        lastError = response.errorMessage || "请求失败";
        if (isInputOverflow(lastError)) throw new InputTooLongError(lastError);
        progress({ phase: "request_retry", label, attempt, error: lastError.slice(0, 300) });
        await sleep(2000 * attempt, options.signal);
        continue;
      }
      if (response.stopReason === "length") {
        // 写到一半被截断：给一次更大的输出额度；还不够，就让上一层把这块切小。
        const larger = Math.min(tokens * 2, model.maxTokens > 0 ? model.maxTokens : tokens * 2);
        if (!lengthRetried && larger > tokens) {
          lengthRetried = true;
          tokens = larger;
          progress({ phase: "request_length_retry", label, maxTokens: tokens });
          attempt--;
          continue;
        }
        throw new InputTooLongError(`${label}：摘要写到一半被截断（输出额度 ${tokens}）`);
      }
      if (response.content.some((block) => block.type === "toolCall")) {
        lastError = `${label}：模型想调用工具，没有写摘要`;
        continue;
      }
      return { text: textOf(response), inputTokens: response.usage?.input ?? 0, outputTokens: response.usage?.output ?? 0 };
    }
    throw new Error(`${label} 失败（已试 ${attempts} 次）：${lastError}`);
  };
}
