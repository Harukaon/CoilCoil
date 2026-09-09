import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CoilCoilRuntime, CoilCoilRuntimeOptions } from "@coilcoil/runtime-core";
import { issueAgentExtensionPath } from "@coilcoil/runtime-core";
import type { PromptImage, RuntimeEvent } from "@coilcoil/runtime-protocol";

/**
 * 任务面板上一条任务的后台运行。
 *
 * 这里最重要的一条是它**不是**一次普通对话。用户对这块的要求原话是：「这本来就是
 * 完全两个隔离的东西……它只和 issue 相关联」。所以这条运行：
 *
 * - 有自己的 runtime 和自己的会话目录（放在 agentDir/issues/runs/ 下），工作区的
 *   会话列表扫的是 sessionDir，永远扫不到这里，侧栏因此不会多出一条对话；
 * - 事件不往界面送，用户看不到它调了什么工具——他要的就是看不到；
 * - 结束时只留下一段结论，写回那条 issue 的时间线。
 *
 * 「必须回复」是这条运行的规矩。它是个黑盒，一轮跑完却什么都没说等于白跑，所以
 * 没调用 issue_reply / issue_ask 就再催一轮；催满上限还不说，就把它最后那段话当成
 * 回复交上去——宁可交一段不那么齐整的话，也不能让用户对着一张没有下文的卡片。
 */

/** 与 packages/workflow/extensions/issue-agent.ts 写的那个文件对应。 */
const ISSUE_RUN_DIR_ENV = "COILCOIL_ISSUE_RUN_DIR";
const ISSUE_REPLY_FILENAME = "reply.json";

/** 催几轮。用户定的量级：「比如说循环5次、循环6次」。 */
const DEFAULT_MAX_TURNS = 5;
/** 一轮最多跑多久。后台没人看着，卡住必须自己了结。 */
const TURN_TIMEOUT_MS = 15 * 60_000;
/** 发出去多久还没开跑，就认定这条运行起不来（最常见的是模型没配好）。 */
const START_TIMEOUT_MS = 60_000;
/** 留几次运行的现场。留着是为了解释一次跑坏了的运行，再老的就是垃圾。 */
const RUNS_KEPT = 20;

/**
 * 这条运行的开场白，和任务正文一起发出去。
 *
 * 放在这里而不是界面那边：这段话说的是「你现在是一条后台任务、只有这两个工具能
 * 说话」，和 issue-agent 那两个工具是一件事的两面，分开写迟早会对不上。
 */
const RUN_PREAMBLE = [
  "你现在在处理任务面板上的一条任务，不是在跟用户对话。",
  "这条运行是后台的：用户看不到你的过程，也不会在中途回你话；你的上下文只有下面这条任务，别去翻别的对话。",
  "做完之后调用 issue_reply 把结论交给他；只有当继续做必须先知道他的取舍时，才调用 issue_ask。",
  "",
].join("\n");

const NUDGE_PROMPT = [
  "你还没有把结论交给用户。",
  "这条任务是后台跑的，用户看不到你上面的任何过程，你不调用工具他就什么都收不到。",
  "现在就调用 issue_reply 交结论；如果确实卡在一个只有他能定的问题上，就调用 issue_ask。",
].join("\n");

export interface IssueRunRequest {
  cwd: string;
  issueId: string;
  prompt: string;
  images?: PromptImage[];
  maxTurns?: number;
}

export interface IssueRunResult {
  /** reply：做完了等验收；ask：等用户拿主意；fallback：催满了还没回复，交的是它最后那段话。 */
  kind: "reply" | "ask" | "fallback";
  text: string;
  verify?: string;
  turns: number;
}

interface StoredReply {
  kind: "reply" | "ask";
  text: string;
  verify?: string;
}

/** 读这条运行写下的回复；没写、或者写坏了，都当成没回复。 */
export function readIssueReply(runDir: string): StoredReply | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(runDir, ISSUE_REPLY_FILENAME), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredReply>;
    if (parsed.kind !== "reply" && parsed.kind !== "ask") return undefined;
    if (typeof parsed.text !== "string" || !parsed.text.trim()) return undefined;
    return {
      kind: parsed.kind,
      text: parsed.text.trim(),
      verify: typeof parsed.verify === "string" && parsed.verify.trim() ? parsed.verify.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

/** 目录名以时间戳开头，所以排序就是排年龄。删不掉不算失败。 */
function pruneRuns(runsDir: string, keep = RUNS_KEPT): void {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return;
  }
  for (const name of names.sort().slice(0, Math.max(0, names.length - keep))) {
    try {
      rmSync(join(runsDir, name), { recursive: true, force: true });
    } catch {
      // 清不掉一份旧现场，不该让这次运行失败。
    }
  }
}

/** 文件名里不能有工作区路径里的斜杠和空格。 */
function runDirectoryName(issueId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${issueId.replace(/[^\w.-]/g, "_").slice(0, 40)}`;
}

/**
 * 等这一轮跑完。
 *
 * 「跑完」= 先看到它开始跑，再看到它停下来。只等「停下来」不行：prompt 刚发出去
 * 那一刻它还没开始，run_state 里的那个 false 是上一刻的状态。
 */
function waitForTurn(signals: TurnSignals, startTimeoutMs: number, turnTimeoutMs: number): Promise<"finished" | "never-started" | "timeout"> {
  // 这一轮可能在我们开始等之前就已经结束了（prompt 只是把话交出去，跑完是另一回
  // 事，两者之间隔着几个微任务）。所以先看有没有已经结算过。
  if (signals.settled) return Promise.resolve("finished");
  return new Promise((resolve) => {
    let startTimer: ReturnType<typeof setTimeout>;
    let runTimer: ReturnType<typeof setTimeout>;
    const finish = (outcome: "finished" | "never-started" | "timeout"): void => {
      clearTimeout(startTimer);
      clearTimeout(runTimer);
      signals.onSettled = undefined;
      resolve(outcome);
    };
    startTimer = setTimeout(() => {
      if (!signals.started) finish("never-started");
    }, startTimeoutMs);
    runTimer = setTimeout(() => finish("timeout"), turnTimeoutMs);
    signals.onSettled = () => finish("finished");
  });
}

interface TurnSignals {
  started: boolean;
  settled: boolean;
  onSettled?: () => void;
}

export interface IssueRunDependencies {
  createRuntime(options: CoilCoilRuntimeOptions): CoilCoilRuntime;
  /** 让这条运行和主 runtime 共用一份模型运行时，省掉一次凭据初始化。 */
  modelRuntimePromise?: CoilCoilRuntimeOptions["modelRuntimePromise"];
  /** 测试用：把那两个以分钟计的等待缩短到毫秒。 */
  startTimeoutMs?: number;
  turnTimeoutMs?: number;
}

/**
 * 跑一条任务，返回要写回那条 issue 的结论。
 *
 * 抛出异常只有一种情况：这条运行根本起不来（模型没配好、工作区没了）。面板会把
 * 任务退回「待处理」并把原因记进时间线。
 */
export async function runIssueTask(
  options: CoilCoilRuntimeOptions,
  request: IssueRunRequest,
  dependencies: IssueRunDependencies,
): Promise<IssueRunResult> {
  const runsDir = join(options.agentDir, "issues", "runs");
  const runDir = join(runsDir, runDirectoryName(request.issueId));
  mkdirSync(runDir, { recursive: true });
  const signals: TurnSignals = { started: false, settled: false };
  const previousRunDir = process.env[ISSUE_RUN_DIR_ENV];
  // 扩展在加载的那一刻读它，而加载就发生在下面 createSession 的过程里。
  process.env[ISSUE_RUN_DIR_ENV] = runDir;
  const runtime = dependencies.createRuntime({
    ...options,
    sessionDir: join(runDir, "sessions"),
    additionalExtensionPaths: [
      ...options.additionalExtensionPaths ?? [],
      issueAgentExtensionPath(options.workflowDir),
    ],
    modelRuntimePromise: dependencies.modelRuntimePromise,
    // 自己的浏览器作用域：它在后台开的标签页不该冒到用户正看着的那个浏览器面板里。
    browserScopeId: `issue-${request.issueId}`,
    onEvent: (event: RuntimeEvent) => {
      if (event.type !== "run_state") return;
      if (event.running) { signals.started = true; return; }
      if (!signals.started) return;
      signals.settled = true;
      signals.onSettled?.();
    },
  });

  const startTimeoutMs = dependencies.startTimeoutMs ?? START_TIMEOUT_MS;
  const turnTimeoutMs = dependencies.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  try {
    await runtime.createSession(request.cwd);
    const maxTurns = Math.max(1, request.maxTurns ?? DEFAULT_MAX_TURNS);
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      signals.started = false;
      signals.settled = false;
      const first = turn === 1;
      await runtime.prompt(first ? `${RUN_PREAMBLE}${request.prompt}` : NUDGE_PROMPT, first ? request.images ?? [] : []);
      const outcome = await waitForTurn(signals, startTimeoutMs, turnTimeoutMs);
      const reply = readIssueReply(runDir);
      if (reply) return { ...reply, turns: turn };
      if (outcome === "never-started") {
        throw new Error("这条任务没能开始——对话没有起来，多半是模型还没配好。");
      }
      if (outcome === "timeout") {
        return {
          kind: "fallback",
          text: "这一轮跑太久了，已经掐掉。它没有留下结论，可能是卡在某一步了。",
          turns: turn,
        };
      }
    }
    const snapshot = await runtime.snapshot();
    const lastText = [...snapshot.messages].reverse()
      .find((message) => message.role === "assistant" && message.text.trim())?.text.trim();
    return {
      kind: "fallback",
      text: lastText || "它跑完了，但一句结论都没留下。",
      turns: maxTurns,
    };
  } finally {
    if (previousRunDir === undefined) delete process.env[ISSUE_RUN_DIR_ENV];
    else process.env[ISSUE_RUN_DIR_ENV] = previousRunDir;
    await runtime.dispose().catch(() => undefined);
    pruneRuns(runsDir);
  }
}
