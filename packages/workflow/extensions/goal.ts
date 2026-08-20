import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Public event channel consumed by SuoCode's bundled runtime. */
export const GOAL_STATE_CHANNEL = "suocode:goal:state:v1";
export const GOAL_STATE_ENTRY = "suocode-goal-state";

export const GOAL_TOOL_NAME = "goal_complete";

/** How often the loop driver checks whether another round is due. */
const TICK_MS = 1_500;
/** Pause between a settled turn and the next round. */
const LOOP_DELAY_MS = 1_000;
/**
 * Pause after a turn that ended in an error.
 *
 * Deliberately flat: an unreliable upstream is the reason this loop exists, and
 * backing off further would only slow down the retry that usually succeeds.
 */
const RETRY_DELAY_MS = 3_000;
/**
 * How long a round waits for its agent run to begin before it is sent again.
 *
 * This is not a response timeout. Pi reports the session busy from the moment
 * the run starts until it settles, so a provider that thinks for minutes never
 * reaches this path. It only covers a round whose run never began at all — a
 * prompt rejected before the agent loop, such as a missing credential — which
 * produces no `agent_settled` and would otherwise leave the loop waiting
 * forever.
 */
const RESEND_UNSTARTED_AFTER_MS = 60_000;

export type GoalStatus = "running" | "paused" | "completed" | "stopped";

export interface GoalState {
  version: 1;
  status: GoalStatus;
  goal: string;
  /** Rounds the loop has sent so far; the first prompt is round 1. */
  iteration: number;
  startedAt: number;
  updatedAt: number;
  /** Set by the model when it calls `goal_complete`. */
  summary?: string;
  /** Last turn error, kept so the next round can react to it. */
  lastError?: string;
}

interface GoalCompleteDetails {
  goal: string;
  summary: string;
  verification?: string;
  iteration: number;
  error?: string;
}

const GoalCompleteParams = Type.Object({
  summary: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "目标已经达成的说明：做了什么、最终结果是什么",
  }),
  verification: Type.Optional(Type.String({
    maxLength: 2_000,
    description: "自行验证的方式与结果，例如运行了哪些命令、检查了哪些输出",
  })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanGoalText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 4_000);
}

/** `/goal` sub-commands that control an existing loop instead of starting one. */
export type GoalCommand =
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "start"; goal: string };

export function parseGoalCommand(args: string): GoalCommand {
  const text = cleanGoalText(args);
  if (!text) return { kind: "resume" };
  const lowered = text.toLowerCase();
  if (["stop", "off", "cancel", "停止", "结束", "取消", "停下"].includes(lowered)) return { kind: "stop" };
  if (["status", "状态", "查看"].includes(lowered)) return { kind: "status" };
  return { kind: "start", goal: text };
}

/**
 * The loop the session is in, as reported to the runtime and the app.
 *
 * A loop that completed or was stopped is over: it leaves the runtime snapshot
 * instead of lingering there as a finished status, so no consumer has to decide
 * whether a goal is worth showing. What happened is already in the timeline —
 * the `goal_complete` result, or the notice `/goal stop` prints.
 *
 * The extension keeps its own record of the ended loop, because `/goal` resumes
 * a stopped one and `/goal status` answers from it.
 */
export function reportedGoalState(state?: GoalState): GoalState | undefined {
  if (!state) return undefined;
  return state.status === "running" || state.status === "paused" ? state : undefined;
}

export function restoredGoalState(entries: readonly unknown[]): GoalState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY || !isRecord(entry.data)) continue;
    const data = entry.data;
    if (typeof data.goal !== "string" || !data.goal.trim()) return undefined;
    const status = data.status;
    if (status !== "running" && status !== "paused" && status !== "completed" && status !== "stopped") return undefined;
    return {
      version: 1,
      // A reloaded session never resumes an endless loop on its own: the user
      // asks for it again with `/goal`.
      status: status === "running" ? "paused" : status,
      goal: data.goal,
      iteration: typeof data.iteration === "number" && data.iteration >= 0 ? Math.floor(data.iteration) : 0,
      startedAt: typeof data.startedAt === "number" ? data.startedAt : Date.now(),
      updatedAt: Date.now(),
      summary: typeof data.summary === "string" ? data.summary : undefined,
      lastError: typeof data.lastError === "string" ? data.lastError : undefined,
    };
  }
  return undefined;
}

export function buildGoalPrompt(state: GoalState, round: number): string {
  const lines = [
    `【目标模式 · 第 ${round} 轮】必须完成的目标：`,
    "",
    state.goal,
    "",
  ];
  if (round === 1) {
    lines.push(
      "请按下面的方式开始：",
      "1. 先用 todo 工具写出完成该目标的计划；",
      "2. 立刻执行计划里的第一步，不要只做汇报；",
    );
  } else {
    lines.push(
      "请按下面的方式继续：",
      "1. 先检查上一轮的实际结果，更新 todo 计划；",
      "2. 继续执行计划里未完成的下一步，本轮必须有实际进展；",
    );
  }
  lines.push(
    "3. 目标未达成前循环不会停止，遇到失败就换方法重试；",
    `4. 只有当目标真正达成、并且你已经自行验证过时，才调用 ${GOAL_TOOL_NAME} 工具结束循环。`,
  );
  return lines.join("\n");
}

export default function goalExtension(pi: ExtensionAPI): void {
  let state: GoalState | undefined;
  let currentContext: ExtensionContext | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  /** Wall-clock time the next round may be sent; `undefined` while a round is in flight. */
  let nextSendAt: number | undefined;
  /** When the round now in flight was handed to Pi, until its run begins. */
  let roundSentAt: number | undefined;
  let lastTurnFailed = false;

  const publish = (): void => {
    const reported = reportedGoalState(state);
    pi.events.emit(GOAL_STATE_CHANNEL, reported ? { ...reported } : null);
  };

  const persist = (): void => {
    if (!state) return;
    pi.appendEntry(GOAL_STATE_ENTRY, {
      version: 1,
      status: state.status,
      goal: state.goal,
      iteration: state.iteration,
      startedAt: state.startedAt,
      summary: state.summary,
      lastError: state.lastError,
    });
  };

  const setGoalTool = (enabled: boolean): void => {
    const active = new Set(pi.getActiveTools());
    if (enabled === active.has(GOAL_TOOL_NAME)) return;
    if (enabled) active.add(GOAL_TOOL_NAME);
    else active.delete(GOAL_TOOL_NAME);
    pi.setActiveTools([...active]);
  };

  const stopTicker = (): void => {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = undefined;
  };

  const sendRound = (repeat = false): void => {
    if (!state || state.status !== "running") return;
    if (!repeat) state.iteration += 1;
    state.updatedAt = Date.now();
    nextSendAt = undefined;
    roundSentAt = Date.now();
    const prompt = buildGoalPrompt(state, state.iteration);
    if (!repeat) publish();
    pi.sendUserMessage(prompt);
  };

  const tick = (): void => {
    if (!state || state.status !== "running") {
      stopTicker();
      return;
    }
    const ctx = currentContext;
    if (!ctx) return;
    // Pi reports the session busy for the whole run, however long the provider
    // takes to answer, so an unfinished turn simply owns the loop here.
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (roundSentAt !== undefined) {
      // Idle with a round outstanding means its run never began. Re-send the
      // same round rather than counting a new one.
      if (Date.now() - roundSentAt < RESEND_UNSTARTED_AFTER_MS) return;
      sendRound(true);
      return;
    }
    if (nextSendAt === undefined || Date.now() < nextSendAt) return;
    sendRound();
  };

  const startTicker = (): void => {
    if (ticker) return;
    ticker = setInterval(tick, TICK_MS);
    ticker.unref?.();
  };

  const startLoop = (goal: string, ctx: ExtensionContext): void => {
    const now = Date.now();
    state = {
      version: 1,
      status: "running",
      goal,
      iteration: 0,
      startedAt: now,
      updatedAt: now,
    };
    lastTurnFailed = false;
    roundSentAt = undefined;
    currentContext = ctx;
    setGoalTool(true);
    persist();
    startTicker();
    sendRound();
  };

  const endLoop = (status: Exclude<GoalStatus, "running">, summary?: string): void => {
    if (!state) return;
    state.status = status;
    state.updatedAt = Date.now();
    if (summary) state.summary = summary;
    nextSendAt = undefined;
    roundSentAt = undefined;
    lastTurnFailed = false;
    stopTicker();
    setGoalTool(false);
    persist();
    publish();
  };

  pi.registerCommand("goal", {
    description: "设定一个必须完成的目标，进入不会自行停止的 Agent 循环",
    handler: async (args, ctx) => {
      currentContext = ctx;
      const command = parseGoalCommand(args);
      if (command.kind === "stop") {
        if (!state || state.status !== "running") {
          ctx.ui.notify("当前没有进行中的目标循环", "info");
          return;
        }
        const rounds = state.iteration;
        endLoop("stopped");
        ctx.ui.notify(`目标循环已停止（共 ${rounds} 轮）`, "info");
        return;
      }
      if (command.kind === "status") {
        if (!state) {
          ctx.ui.notify("当前没有目标；用法：/goal <目标>", "info");
          return;
        }
        ctx.ui.notify(`目标（${state.status}，第 ${state.iteration} 轮）：${state.goal}`, "info");
        return;
      }
      if (command.kind === "resume") {
        if (state && (state.status === "paused" || state.status === "stopped")) {
          state.status = "running";
          state.lastError = undefined;
          state.updatedAt = Date.now();
          lastTurnFailed = false;
          roundSentAt = undefined;
          setGoalTool(true);
          persist();
          nextSendAt = Date.now();
          startTicker();
          publish();
          ctx.ui.notify(`目标循环已继续：${state.goal}`, "info");
          return;
        }
        if (state?.status === "running") {
          ctx.ui.notify(`目标循环进行中（第 ${state.iteration} 轮）：${state.goal}`, "info");
          return;
        }
        ctx.ui.notify("用法：/goal <目标>，或 /goal stop 停止当前目标", "warning");
        return;
      }
      if (state?.status === "running") endLoop("stopped");
      startLoop(command.goal, ctx);
      ctx.ui.notify(`目标循环已开始：${command.goal}`, "info");
    },
  });

  pi.registerTool({
    name: GOAL_TOOL_NAME,
    label: "完成目标",
    description:
      "在目标模式下声明目标已经真正达成并结束循环。只有当目标已经完成、并且你已自行验证过结果时才可以调用；未完成时调用会被拒绝。",
    promptSnippet: `${GOAL_TOOL_NAME}: 目标达成后结束目标循环`,
    promptGuidelines: [
      `目标模式进行中时，只有确认目标真正完成并验证通过，才调用 ${GOAL_TOOL_NAME}；否则继续执行下一步。`,
    ],
    parameters: GoalCompleteParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentContext = ctx;
      if (!state || state.status !== "running") {
        const error = "当前没有进行中的目标循环，无需调用该工具。";
        return {
          content: [{ type: "text", text: error }],
          details: {
            goal: state?.goal ?? "",
            summary: params.summary,
            iteration: state?.iteration ?? 0,
            error,
          } satisfies GoalCompleteDetails,
          isError: true,
        };
      }
      const goal = state.goal;
      const iteration = state.iteration;
      endLoop("completed", params.summary);
      const text = [
        `目标已完成，循环结束（共 ${iteration} 轮）。`,
        `目标：${goal}`,
        `完成说明：${params.summary}`,
        params.verification ? `验证：${params.verification}` : undefined,
      ].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text }],
        details: { goal, summary: params.summary, verification: params.verification, iteration } satisfies GoalCompleteDetails,
      };
    },

    renderCall(args, theme: Theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("完成目标")) + theme.fg("muted", ` · ${args.summary.slice(0, 60)}`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme: Theme) {
      const details = result.details as GoalCompleteDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", details.error), 0, 0);
      return new Text(
        theme.fg("success", `目标已完成（第 ${details?.iteration ?? 0} 轮）`) + (details?.summary ? `\n${details.summary}` : ""),
        0,
        0,
      );
    },
  });

  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    // The run began: the loop now waits for the turn, not for the clock.
    if (state?.status !== "running") return;
    roundSentAt = undefined;
    nextSendAt = undefined;
  });

  pi.on("agent_end", (event, ctx) => {
    currentContext = ctx;
    if (!state || state.status !== "running") return;
    const failure = event.messages.find((message) => (
      isRecord(message) && message.role === "assistant" && message.stopReason === "error"
    ));
    const errorMessage = isRecord(failure) && typeof failure.errorMessage === "string"
      ? failure.errorMessage
      : undefined;
    state.lastError = errorMessage;
    lastTurnFailed = Boolean(errorMessage);
  });

  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    if (!state || state.status !== "running") return;
    roundSentAt = undefined;
    nextSendAt = Date.now() + (lastTurnFailed ? RETRY_DELAY_MS : LOOP_DELAY_MS);
    startTicker();
    publish();
  });

  const restore = (ctx: ExtensionContext): void => {
    currentContext = ctx;
    stopTicker();
    nextSendAt = undefined;
    roundSentAt = undefined;
    lastTurnFailed = false;
    state = restoredGoalState(ctx.sessionManager.getBranch());
    setGoalTool(state?.status === "running");
    publish();
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    stopTicker();
    state = undefined;
    currentContext = undefined;
  });
}
