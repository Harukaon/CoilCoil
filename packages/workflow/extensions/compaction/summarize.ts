import { chunkUnits, estimateTextTokens } from "./text.ts";
import type { Usage } from "@earendil-works/pi-ai";
import { addUsage, emptyUsage } from "./usage.ts";

/**
 * 第 2 层：让模型写交接摘要。
 *
 * 1. 材料装得下一次请求，就一次写完（带上上一份摘要，在它的基础上更新）。
 * 2. 装不下（历史太长，或者从大窗口模型换到了小窗口模型），按当前模型的窗口切块，
 *    各块同时总结，再用一次请求合成一份。只并行不合并的话，后一块不知道前一块定过什么。
 * 3. 某一块模型说「太长」，把这块对半切开重来。
 *
 * 每次请求：低思考（摘要是整理活，不需要深想；会话开 max 时一段要想好几分钟，还会把输出
 * 额度吃光，写到一半被截断），迟迟没有任何返回就断开重试，不会无限等下去。
 */

export interface SummaryRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /** 这一次是第几块、哪一步，只用于日志。 */
  label: string;
  /** Cancels sibling requests when another summary chunk fails. */
  signal?: AbortSignal;
}

export interface SummaryResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  usage?: Usage;
}

/** 发一次请求。模型说输入太长时抛 InputTooLongError，其余失败抛普通错误。 */
export type RequestSummary = (request: SummaryRequest) => Promise<SummaryResponse>;

export class InputTooLongError extends Error {
  usage?: Usage;

  constructor(message: string, usage?: Usage) {
    super(message);
    this.name = "InputTooLongError";
    this.usage = usage;
  }
}

export interface SummarizeOptions {
  /** 这次要总结的材料，一条消息一段，按时间顺序。 */
  units: string[];
  /** 上一份模型写的摘要（在它基础上更新）。整理稿不走这里，它是材料。 */
  previousSummary?: string;
  /** 用户在 /compact 后面写的要求。 */
  customInstructions?: string;
  /** 写摘要的模型的窗口。 */
  contextWindow: number;
  /** 写摘要的模型单次最多能输出多少。 */
  modelMaxTokens: number;
  request: RequestSummary;
  /** An exact copy of a recent Claude request can share its conversation cache. */
  prefixRequest?: RequestSummary;
  concurrency?: number;
  onProgress?: (event: Record<string, string | number | boolean | undefined>) => void;
  signal?: AbortSignal;
}

export interface SummarizeResult {
  text: string;
  chunks: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usage: Usage;
}

export const SUMMARY_SYSTEM = [
  "你是上下文压缩助手。你会读到一段用户和 AI 编程助手之间的对话记录，任务是写一份交接摘要，",
  "让接手的下一个模型能无缝接着干活。不要继续这段对话，不要回答其中的问题，不要调用任何工具，只输出摘要。",
].join("");

const SECTIONS = [
  "小节标题只写短标题（如「## 目标」），说明文字不要抄进标题：",
  "- ## 目标：用户要做成什么，成功的标准",
  "- ## 约束与偏好：用户提过的要求、偏好、禁止事项（尽量用用户原话）",
  "- ## 已完成：做完了哪些事，改了哪些文件、跑了哪些命令、结果如何",
  "- ## 进行中：正在做什么，执行到哪一步了（这一节最重要，写具体）",
  "- ## 关键决定与踩过的坑：做过的选择和理由；试过但失败的做法，别再重复",
  "- ## 下一步：接下来要做的具体事项，按顺序",
  "- ## 关键上下文：必须原样保留的文件路径、命令、报错原文、变量名、数字，以及对用户做过的承诺",
].join("\n");

const STYLE = [
  "要求：",
  "- 用中文写；路径、命令、报错、代码标识符保留原文，不要翻译。",
  "- 具体胜过笼统：写「src/a.ts 的 parse 函数改成了分块读取」，不写「改了一些代码」。",
  "- 已经不再成立的内容（被推翻的方案、已解决的问题）删掉或标成已解决。",
].join("\n");

function fullPrompt(material: string, previousSummary: string | undefined, customInstructions: string | undefined, limitChars: number): string {
  return [
    previousSummary ? `<上一份摘要>\n${previousSummary}\n</上一份摘要>\n` : "",
    `<对话记录>\n${material}\n</对话记录>\n`,
    previousSummary
      ? "在上一份摘要的基础上，把这段新的对话记录合并进去，写出更新后的完整交接摘要（仍然有效的旧内容保留）。按以下小节："
      : "写一份交接摘要，按以下小节：",
    SECTIONS,
    "",
    STYLE,
    `- 总长控制在 ${limitChars} 字以内。`,
    customInstructions ? `\n用户额外要求：${customInstructions}` : "",
  ].filter(Boolean).join("\n");
}

function partPrompt(material: string, index: number, total: number, limitChars: number): string {
  return [
    `<对话记录 第 ${index}/${total} 段>\n${material}\n</对话记录>\n`,
    `这是一段很长对话里按时间顺序的第 ${index} 段（共 ${total} 段）。只总结这一段：发生了什么、做了哪些决定、改了哪些文件、`,
    "遇到了什么问题、结果如何；段末时正在做什么。路径、命令、报错保留原文。用中文，",
    `控制在 ${limitChars} 字以内。不要写开场白。`,
  ].join("\n");
}

function mergePrompt(parts: string[], previousSummary: string | undefined, customInstructions: string | undefined, limitChars: number): string {
  const body = parts.map((part, index) => `<第 ${index + 1} 段的总结>\n${part}\n</第 ${index + 1} 段的总结>`).join("\n\n");
  return [
    previousSummary ? `<上一份摘要>\n${previousSummary}\n</上一份摘要>\n` : "",
    body,
    "",
    `上面是${previousSummary ? "上一份摘要之后，" : ""}一段长对话按时间顺序分段写的总结。把它们合成一份完整的交接摘要：`,
    "后面的段落推翻前面的，以后面为准；「进行中」「下一步」以最后一段为准。按以下小节：",
    SECTIONS,
    "",
    STYLE,
    `- 总长控制在 ${limitChars} 字以内。`,
    customInstructions ? `\n用户额外要求：${customInstructions}` : "",
  ].filter(Boolean).join("\n");
}

/** Pi reserves this room before clamping output; budget material before that clamp reaches one token. */
const CONTEXT_RESERVE = 4096;

/** 一次请求的材料预算，另给系统指令、摘要格式和输出留出空间。 */
export function requestBudget(contextWindow: number): number {
  return Math.max(1, Math.min(Math.floor((contextWindow - CONTEXT_RESERVE) * 0.5), 120_000));
}

/** 按预算把若干段分组，保持顺序。 */
export function groupByBudget(parts: readonly string[], budgetTokens: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const part of parts) {
    const tokens = estimateTextTokens(part);
    if (current.length && used + tokens > budgetTokens) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(part);
    used += tokens;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>, onError: (error: unknown) => void): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const workers = Array.from({ length: Math.min(Math.max(1, Math.floor(limit) || 1), items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index], index);
      } catch (error) {
        if (!failure) {
          failure = { error };
          onError(error);
        }
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure.error;
  return results;
}

export async function summarize(options: SummarizeOptions): Promise<SummarizeResult> {
  if (options.contextWindow <= CONTEXT_RESERVE) throw new Error("摘要模型的上下文窗口过小，无法同时容纳摘要指令和输出，请选择更大窗口的摘要模型");
  const budget = requestBudget(options.contextWindow);
  const finalMax = Math.max(1, Math.min(options.modelMaxTokens || 16_000, 16_000));
  const partMax = Math.max(1, Math.min(options.modelMaxTokens || 8000, 8000, Math.floor((options.contextWindow - CONTEXT_RESERVE) / 5)));
  const batch = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, batch.signal]) : batch.signal;
  const abortBatch = (error: unknown): void => batch.abort(error);
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, usage: emptyUsage() };
  const progress = options.onProgress ?? (() => undefined);

  const call = async (request: SummaryRequest, send = options.request): Promise<string> => {
    if (signal.aborted) throw new Error("压缩已取消");
    if (send === options.request) {
      // Use the larger of our CJK-aware estimate and the SDK's chars/3.5
      // estimate. Count the actual complete prompt, including old summaries
      // and user instructions, before choosing a useful output allowance.
      const tokens = (text: string): number => Math.max(estimateTextTokens(text), Math.ceil(text.length / 3.5));
      const available = options.contextWindow - tokens(request.system) - tokens(request.prompt) - CONTEXT_RESERVE - 32;
      if (available < Math.min(1024, request.maxTokens)) throw new InputTooLongError(`${request.label}：输入和摘要输出超过模型窗口，需要进一步分块`);
      request = { ...request, maxTokens: Math.min(request.maxTokens, available) };
    }
    stats.calls++;
    const startedAt = Date.now();
    progress({ phase: "request_started", label: request.label, promptTokens: estimateTextTokens(request.prompt) });
    let response: SummaryResponse;
    try {
      response = await send({ ...request, signal });
    } catch (error) {
      if (error instanceof InputTooLongError && error.usage) {
        stats.inputTokens += error.usage.input;
        stats.outputTokens += error.usage.output;
        addUsage(stats.usage, error.usage);
      }
      throw error;
    }
    stats.inputTokens += response.inputTokens;
    stats.outputTokens += response.outputTokens;
    const usage = response.usage ?? { ...emptyUsage(), input: response.inputTokens, output: response.outputTokens, totalTokens: response.inputTokens + response.outputTokens };
    addUsage(stats.usage, usage);
    progress({ phase: "request_completed", label: request.label, ms: Date.now() - startedAt, outputChars: response.text.length,
      inputTokens: usage.input, outputTokens: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
    if (!response.text.trim()) throw new Error(`${request.label}：模型返回了空摘要`);
    return response.text.trim();
  };

  /** 总结一块；模型说太长，就对半切开，前后两半各自总结（不超过三层）。 */
  const summarizePart = async (material: string, index: number, total: number, depth = 0): Promise<string[]> => {
    try {
      return [await call({ system: SUMMARY_SYSTEM, prompt: partPrompt(material, index, total, 4000), maxTokens: partMax, label: `第 ${index}/${total} 段` })];
    } catch (error) {
      if (!(error instanceof InputTooLongError) || depth >= 3 || material.length < 2000) throw error;
      progress({ phase: "part_split", label: `第 ${index}/${total} 段`, depth: depth + 1 });
      const middle = material.lastIndexOf("\n\n【", Math.floor(material.length / 2));
      const cut = middle > material.length / 4 ? middle : Math.floor(material.length / 2);
      const first = await summarizePart(material.slice(0, cut), index, total, depth + 1);
      const second = await summarizePart(material.slice(cut), index, total, depth + 1);
      return [...first, ...second];
    }
  };

  /** 把几段总结合成一份；合并的材料本身也装不下，就先分组合并（最多两轮，每轮段数必须变少）。 */
  const merge = async (parts: string[], previous: string | undefined, round = 0): Promise<string> => {
    const prompt = mergePrompt(parts, previous, options.customInstructions, 10_000);
    const groups = groupByBudget(parts, budget);
    if (estimateTextTokens(prompt) <= budget || parts.length <= 2 || round >= 2 || groups.length >= parts.length) {
      return call({ system: SUMMARY_SYSTEM, prompt, maxTokens: finalMax, label: `合并 ${parts.length} 段` });
    }
    progress({ phase: "merge_grouped", parts: parts.length, groups: groups.length });
    const merged = await mapLimit(groups, options.concurrency ?? 4, (group, index) => call({
      system: SUMMARY_SYSTEM,
      prompt: mergePrompt(group, undefined, undefined, 6000),
      maxTokens: partMax,
      label: `分组合并 ${index + 1}/${groups.length}`,
    }), abortBatch);
    return merge(merged, previous, round + 1);
  };

  if (options.prefixRequest) {
    try {
      const text = await call({
        system: SUMMARY_SYSTEM,
        prompt: [
          "请根据上面的对话写一份交接摘要。最近的一段对话还会原样保留，重点整理更早的目标、约束、决定和未完成工作。",
          SECTIONS, STYLE, "- 总长控制在 10000 字以内。",
          options.customInstructions ? `用户额外要求：${options.customInstructions}` : "",
        ].filter(Boolean).join("\n"),
        maxTokens: finalMax,
        label: "复用会话缓存",
      }, options.prefixRequest);
      return { text, chunks: 1, ...stats };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!(error instanceof InputTooLongError) && !/signature|prefix.mismatch|thinking.block|tool_use|tool_result/i.test(String(error))) throw error;
      progress({ phase: "prefix_fallback", reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
    }
  }

  const material = options.units.join("\n\n");
  const previousTokens = estimateTextTokens(options.previousSummary ?? "");
  if (estimateTextTokens(material) + previousTokens <= budget) {
    try {
      const text = await call({
        system: SUMMARY_SYSTEM,
        prompt: fullPrompt(material, options.previousSummary, options.customInstructions, 10_000),
        maxTokens: finalMax,
        label: "一次写完",
      });
      return { text, chunks: 1, ...stats };
    } catch (error) {
      // 估算说装得下，模型却说太长（估算和真实分词有差距）：退到分块。
      if (!(error instanceof InputTooLongError)) throw error;
      progress({ phase: "single_overflowed_fallback_to_chunks" });
    }
  }

  // 旧摘要也可能大于新模型的窗口。分块时把它放在最前面一起处理，
  // 不能只压新消息，最后合并时又把超长旧摘要原样塞回去。
  const units = options.previousSummary
    ? [`【更早内容的摘要】\n${options.previousSummary}`, ...options.units]
    : options.units;
  const chunks = chunkUnits(units, budget);
  const effectiveChunks = chunks.length > 1 ? chunks : chunkUnits(units, Math.floor(budget / 2));
  progress({ phase: "chunked", chunks: effectiveChunks.length, budgetTokens: budget });
  const partsNested = await mapLimit(effectiveChunks, options.concurrency ?? 4, (chunk, index) => summarizePart(chunk, index + 1, effectiveChunks.length), abortBatch);
  const parts = partsNested.flat();
  const text = await merge(parts, undefined);
  return { text, chunks: effectiveChunks.length, ...stats };
}
