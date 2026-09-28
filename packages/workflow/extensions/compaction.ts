import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  getAgentDir,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { createStreamRequest } from "./compaction/request.ts";
import { summarize } from "./compaction/summarize.ts";
import {
  cleanedBody,
  composeCleaned,
  estimateMessageTokens,
  estimateTextTokens,
  fileListSection,
  renderCleaned,
  renderForSummary,
  type LlmMessage,
} from "./compaction/text.ts";

/**
 * CoilCoil 自己的上下文压缩。
 *
 * Pi 管「什么时候压、最近保留多少（2 万 token，Pi 的 keepRecentTokens）、压完写进会话」，
 * 这里只管「保留区之外的那段历史变成什么」。两层，能停在第 1 层就不走第 2 层，目标是
 * **压缩次数尽量少**：
 *
 * 第 1 层（不调模型，一次就好）：删掉思考过程，工具输出只留一行痕迹，用户和助手的原话
 *   一字不动。估算压完的上下文 ≤ 窗口的 35% 才采用——压完留不出足够空间，没多久又得压，
 *   不如直接走第 2 层。
 * 第 2 层（调模型）：删掉思考过程，工具调用和结果都留，让模型写一份交接摘要。装不下一次
 *   请求就分块同时写、再合并（见 compaction/summarize.ts）。失败就明确取消，不落一个半截的
 *   结果，也不让 Pi 拿原始历史再压一遍（超大会话那条路必然 400）。
 *
 * 原始会话文件从来不改；被压掉的原文由 context-transcript 存成纯文字存档，模型需要细节时
 * 按系统提示里的路径去查。
 */

export const COMPACTION_EVENT = "coilcoil:compaction:v1";
/** 第 1 层压完要落到窗口的多少以内才采用。 */
export const LAYER1_TARGET_RATIO = 0.35;
/** Pi 把摘要包成一条消息时加的前后缀，大约这么多。 */
const SUMMARY_WRAPPER_TOKENS = 80;
/** 同一处压缩失败后，多久之内自动压缩不再重试（手动 /compact 不受限）。 */
const FAILURE_COOLDOWN_MS = 10 * 60_000;

type Entry = SessionBeforeCompactEvent["branchEntries"][number];

export interface CompactionDetails {
  coilcoil: {
    version: 1;
    layer: 1 | 2;
    estimatedAfter: number;
    targetTokens: number;
    contextWindow: number;
    chunks?: number;
    calls?: number;
    ms: number;
    model?: string;
  };
  readFiles: string[];
  modifiedFiles: string[];
}

/** 保留区（Pi 切点之后）原样发给模型的量。 */
export function keptTokens(branch: readonly Entry[], firstKeptEntryId: string): number {
  const index = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (index < 0) return 0;
  let total = 0;
  for (const entry of branch.slice(index)) {
    if (entry.type === "compaction") continue;
    for (const message of sessionEntryToContextMessages(entry)) total += estimateMessageTokens(message);
  }
  return total;
}

/** Pi 只接上它自己压出来的文件清单，我们交回的它不认，所以自己从上一次的记录里接上。 */
export function mergedFileOps(
  fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"],
  branch: readonly Entry[],
): { read: Set<string>; written: Set<string>; edited: Set<string> } {
  const merged = { read: new Set(fileOps.read), written: new Set(fileOps.written), edited: new Set(fileOps.edited) };
  const previous = [...branch].reverse().find((entry) => entry.type === "compaction") as { details?: unknown } | undefined;
  const details = previous?.details as Partial<CompactionDetails> | undefined;
  if (details && Array.isArray(details.readFiles)) for (const path of details.readFiles) if (typeof path === "string") merged.read.add(path);
  if (details && Array.isArray(details.modifiedFiles)) for (const path of details.modifiedFiles) if (typeof path === "string") merged.edited.add(path);
  return merged;
}

export interface Layer1Plan {
  text: string;
  estimatedAfter: number;
  targetTokens: number;
  accept: boolean;
}

/**
 * 第 1 层：整理出清理稿，估算压完的总量，决定采不采用。
 *
 * 压完的总量 = 固定开销（系统提示 + 工具说明）+ 清理稿 + 保留区。
 */
export function planLayer1(options: {
  messages: readonly LlmMessage[];
  previousSummary?: string;
  files: string;
  keptTokens: number;
  overheadTokens: number;
  contextWindow: number;
}): Layer1Plan {
  const previousBody = options.previousSummary ? cleanedBody(options.previousSummary) : undefined;
  const text = composeCleaned({
    previousBody,
    previousSummary: previousBody === undefined ? options.previousSummary : undefined,
    cleaned: renderCleaned(options.messages),
    files: options.files,
  });
  const estimatedAfter = options.overheadTokens + options.keptTokens + estimateTextTokens(text) + SUMMARY_WRAPPER_TOKENS;
  const targetTokens = Math.floor(options.contextWindow * LAYER1_TARGET_RATIO);
  return { text, estimatedAfter, targetTokens, accept: estimatedAfter <= targetTokens };
}

/** 总结模型：用户在设置里指定了就用它，否则用会话当前的模型。 */
function summarizationModel(ctx: ExtensionContext): Model<Api> | undefined {
  try {
    const path = join(getAgentDir(), "summarization-model.json");
    if (existsSync(path)) {
      const reference = (JSON.parse(readFileSync(path, "utf8")) as { model?: unknown }).model;
      if (typeof reference === "string" && reference.includes("/")) {
        const at = reference.indexOf("/");
        const found = ctx.modelRegistry.find(reference.slice(0, at), reference.slice(at + 1));
        if (found) return found as Model<Api>;
      }
    }
  } catch {
    // 配置读不到就用会话模型。
  }
  return ctx.model as Model<Api> | undefined;
}

function usageOf(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export default function compactionExtension(pi: ExtensionAPI): void {
  const failures = new Map<string, number>();

  const report = (ctx: ExtensionContext, data: Record<string, unknown>): void => {
    try {
      pi.events.emit(COMPACTION_EVENT, { ...data, sessionFile: ctx.sessionManager.getSessionFile?.() });
    } catch {
      // 日志不能拦住压缩。
    }
  };

  /** 固定开销：系统提示 + 当前启用的工具说明。压缩不改它们，但它们占着窗口。 */
  const overheadTokens = (ctx: ExtensionContext): number => {
    let total = estimateTextTokens(ctx.getSystemPrompt());
    try {
      const active = new Set(pi.getActiveTools());
      for (const tool of pi.getAllTools()) {
        if (!active.has(tool.name)) continue;
        total += estimateTextTokens(`${tool.name}${tool.description ?? ""}${JSON.stringify(tool.parameters ?? {})}`);
      }
    } catch {
      total += 8000;
    }
    return total;
  };

  pi.on("session_before_compact", async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
    const startedAt = Date.now();
    const preparation = event.preparation;
    const model = ctx.model as Model<Api> | undefined;
    if (!model || !(model.contextWindow > 0)) return undefined;
    const contextWindow = model.contextWindow;
    const failureKey = `${ctx.sessionManager.getSessionFile?.() ?? ""}:${preparation.firstKeptEntryId}`;

    const messages = convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]) as LlmMessage[];
    const fileOps = mergedFileOps(preparation.fileOps, event.branchEntries);
    const files = fileListSection(fileOps);
    const kept = keptTokens(event.branchEntries, preparation.firstKeptEntryId);
    const overhead = overheadTokens(ctx);
    const details = (layer: 1 | 2, estimatedAfter: number, targetTokens: number, extra: Partial<CompactionDetails["coilcoil"]> = {}): CompactionDetails => ({
      coilcoil: { version: 1, layer, estimatedAfter, targetTokens, contextWindow, ms: Date.now() - startedAt, ...extra },
      readFiles: [...fileOps.read].slice(-200),
      modifiedFiles: [...new Set([...fileOps.edited, ...fileOps.written])].slice(-200),
    });

    // 第 1 层。用户手动 /compact 时写了额外要求，那是要模型写的摘要，直接走第 2 层。
    const layer1 = planLayer1({ messages, previousSummary: preparation.previousSummary, files, keptTokens: kept, overheadTokens: overhead, contextWindow });
    report(ctx, {
      phase: "layer1_planned",
      reason: event.reason,
      tokensBefore: preparation.tokensBefore,
      messages: messages.length,
      keptTokens: kept,
      overheadTokens: overhead,
      estimatedAfter: layer1.estimatedAfter,
      targetTokens: layer1.targetTokens,
      accept: layer1.accept && !event.customInstructions,
    });
    if (layer1.accept && !event.customInstructions) {
      failures.delete(failureKey);
      report(ctx, { phase: "done", layer: 1, estimatedAfter: layer1.estimatedAfter, ms: Date.now() - startedAt });
      return {
        compaction: {
          summary: layer1.text,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          estimatedTokensAfter: layer1.estimatedAfter,
          details: details(1, layer1.estimatedAfter, layer1.targetTokens),
        },
      };
    }

    // 第 2 层。
    const failedAt = failures.get(failureKey);
    if (event.reason !== "manual" && failedAt !== undefined && Date.now() - failedAt < FAILURE_COOLDOWN_MS) {
      report(ctx, { phase: "skipped", reason: event.reason, why: "同一处刚压失败过，十分钟内不自动重试" });
      return { cancel: true };
    }
    const summaryModel = summarizationModel(ctx) ?? model;
    const modelName = `${summaryModel.provider}/${summaryModel.id}`;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
      if (!auth.ok) throw new Error(auth.error);
      const previousBody = preparation.previousSummary ? cleanedBody(preparation.previousSummary) : undefined;
      const units = [...(previousBody ? [previousBody] : []), ...renderForSummary(messages)];
      report(ctx, { phase: "layer2_started", reason: event.reason, model: modelName, units: units.length });
      const onProgress = (data: Record<string, unknown>): void => report(ctx, { ...data, model: modelName });
      const result = await summarize({
        units,
        previousSummary: previousBody === undefined ? preparation.previousSummary : undefined,
        customInstructions: event.customInstructions,
        contextWindow: summaryModel.contextWindow > 0 ? summaryModel.contextWindow : contextWindow,
        modelMaxTokens: summaryModel.maxTokens,
        request: createStreamRequest({ model: summaryModel, auth, signal: event.signal, onProgress }),
        onProgress,
        signal: event.signal,
      });
      const summary = files ? `${result.text}\n\n${files}` : result.text;
      const estimatedAfter = overhead + kept + estimateTextTokens(summary) + SUMMARY_WRAPPER_TOKENS;
      const threshold = contextWindow - preparation.settings.reserveTokens;
      if (estimatedAfter >= threshold) {
        throw new Error(`压完估计仍有 ${estimatedAfter} token，超过自动压缩线 ${threshold}：模型窗口太小，或最近保留的内容本身就太大`);
      }
      failures.delete(failureKey);
      report(ctx, { phase: "done", layer: 2, chunks: result.chunks, calls: result.calls, estimatedAfter, ms: Date.now() - startedAt, model: modelName });
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          estimatedTokensAfter: estimatedAfter,
          usage: usageOf(result.inputTokens, result.outputTokens),
          details: details(2, estimatedAfter, layer1.targetTokens, { chunks: result.chunks, calls: result.calls, model: modelName }),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = event.signal.aborted;
      if (!cancelled) failures.set(failureKey, Date.now());
      report(ctx, { phase: cancelled ? "cancelled" : "failed", reason: event.reason, error: message.slice(0, 500), ms: Date.now() - startedAt, model: modelName });
      // 明确取消：会话保持原样。不返回 undefined——那样 Pi 会拿原始历史自己再压一遍。
      return { cancel: true };
    }
  });
}
