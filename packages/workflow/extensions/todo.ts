import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "todo";
const WIDGET_KEY = "hao-todo-plan";
const MAX_VISIBLE_ITEMS = 6;
/**
 * Custom message type carrying the current plan back into the model's context.
 *
 * The tool result alone only reaches the model once, at the moment of the call.
 * A long turn later, the plan sits hundreds of messages back and the model stops
 * acting on it — it neither marks items done nor picks up the next one. This
 * message re-states the plan next to every new user message instead.
 */
const CONTEXT_MESSAGE_TYPE = "coilcoil-todo-state";

export const TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

interface TodoDetails {
  plan: TodoItem[];
  error?: string;
}

interface TodoTheme {
  bold(text: string): string;
  fg(
    color: "accent" | "dim" | "muted" | "success" | "text",
    text: string,
  ): string;
}

const TodoParams = Type.Object({
  plan: Type.Array(
    Type.Object({
      text: Type.String({
        minLength: 1,
        maxLength: 160,
        description: "任务内容",
      }),
      status: StringEnum(TODO_STATUSES),
    }),
    {
      maxItems: 20,
      description: "完整计划；每次调用都替换当前列表，传空数组可清空",
    },
  ),
});

function clonePlan(plan: readonly TodoItem[]): TodoItem[] {
  return plan.map((item) => ({ ...item }));
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return TODO_STATUSES.includes(value as TodoStatus);
}

function readPlan(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const plan: TodoItem[] = [];
  for (const item of value) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("text" in item) ||
      !("status" in item) ||
      typeof item.text !== "string" ||
      !isTodoStatus(item.status)
    ) {
      return undefined;
    }
    const text = item.text
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || Array.from(text).length > 160) return undefined;
    plan.push({ text, status: item.status });
  }

  return plan;
}

export function validateTodoPlan(
  value: unknown,
): { plan: TodoItem[] } | { error: string } {
  const plan = readPlan(value);
  if (!plan) return { error: "计划格式无效" };
  if (plan.length > 20) return { error: "计划最多 20 项" };

  const activeCount = plan.filter(
    (item) => item.status === "in_progress",
  ).length;
  if (activeCount > 1) return { error: "同一时间只能有一项进行中" };

  return { plan };
}

function statusSymbol(status: TodoStatus): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  return "○";
}

function formatPlanForModel(plan: readonly TodoItem[]): string {
  if (plan.length === 0) return "Todo 已清空";

  const completed = plan.filter((item) => item.status === "completed").length;
  return [
    `Todo ${completed}/${plan.length}`,
    ...plan.map(
      (item, index) =>
        `${statusSymbol(item.status)} ${index + 1}. ${item.text} [${item.status}]`,
    ),
  ].join("\n");
}

/**
 * The plan as the model should see it at the start of every round.
 *
 * Returns `undefined` when there is nothing left to track — no plan at all, or
 * one whose items are all completed. Re-stating a finished list every round is
 * pure noise, and an empty list has nothing to say.
 */
export function buildTodoContextText(
  plan: readonly TodoItem[],
): string | undefined {
  const completed = plan.filter((item) => item.status === "completed").length;
  if (plan.length === 0 || completed === plan.length) return undefined;

  const active = plan.find((item) => item.status === "in_progress");
  const lines = [
    "<todo_state>",
    `当前 Todo（已完成 ${completed}/${plan.length}）`,
    ...plan.map((item, index) => {
      const line = `${statusSymbol(item.status)} ${index + 1}. ${item.text}`;
      return item.status === "in_progress" ? `${line} ← 进行中` : line;
    }),
    active
      ? "做完「进行中」这一项就立刻调用 todo 工具更新状态，再开始下一项。"
      : "当前没有进行中的项：开始下一项之前，先用 todo 工具把它标成 in_progress。",
    "</todo_state>",
  ];
  return lines.join("\n");
}

function samePlan(
  left: readonly TodoItem[] | undefined,
  right: readonly TodoItem[],
): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((item, index) =>
    item.text === right[index].text && item.status === right[index].status
  );
}

/**
 * The freshest plan the given context still shows the model.
 *
 * Both the tool's own result and the injected state message carry the plan in
 * `details`, so either one counts as "the model can see it". Used to decide
 * whether context compaction has dropped the plan out of the window.
 */
export function newestTodoStateInContext(
  messages: readonly unknown[],
): TodoItem[] | undefined {
  let newest: TodoItem[] | undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    const isToolResult = record.role === "toolResult" &&
      record.toolName === TOOL_NAME;
    const isStateMessage = record.role === "custom" &&
      record.customType === CONTEXT_MESSAGE_TYPE;
    if (!isToolResult && !isStateMessage) continue;
    if (isTodoDetails(record.details)) newest = clonePlan(record.details.plan);
  }
  return newest;
}

function visibleRange(plan: readonly TodoItem[]): {
  start: number;
  end: number;
} {
  if (plan.length <= MAX_VISIBLE_ITEMS) {
    return { start: 0, end: plan.length };
  }

  const activeIndex = plan.findIndex(
    (item) => item.status === "in_progress",
  );
  const pendingIndex = plan.findIndex((item) => item.status === "pending");
  const focusIndex = activeIndex >= 0
    ? activeIndex
    : pendingIndex >= 0
      ? pendingIndex
      : plan.length - 1;
  const start = Math.max(
    0,
    Math.min(
      focusIndex - Math.floor(MAX_VISIBLE_ITEMS / 2),
      plan.length - MAX_VISIBLE_ITEMS,
    ),
  );
  return { start, end: start + MAX_VISIBLE_ITEMS };
}

export function buildTodoWidgetLines(
  plan: readonly TodoItem[],
  theme: TodoTheme,
): string[] {
  if (plan.length === 0) return [];

  const completed = plan.filter((item) => item.status === "completed").length;
  const { start, end } = visibleRange(plan);
  const lines = [
    theme.fg("accent", theme.bold(`TODO ${completed}/${plan.length}`)),
  ];

  if (start > 0) lines.push(theme.fg("dim", `… 前面 ${start} 项`));

  for (let index = start; index < end; index++) {
    const item = plan[index];
    const prefix = `${statusSymbol(item.status)} ${index + 1}. `;
    if (item.status === "completed") {
      lines.push(theme.fg("dim", `${prefix}${item.text}`));
    } else if (item.status === "in_progress") {
      lines.push(theme.fg("accent", `${prefix}${item.text}`));
    } else {
      lines.push(
        theme.fg("muted", prefix) + theme.fg("text", item.text),
      );
    }
  }

  if (end < plan.length) {
    lines.push(theme.fg("dim", `… 后面 ${plan.length - end} 项`));
  }
  return lines;
}

function isTodoDetails(value: unknown): value is TodoDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    "plan" in value &&
    readPlan(value.plan) !== undefined
  );
}

export default function todoExtension(pi: ExtensionAPI): void {
  let plan: TodoItem[] = [];

  const renderWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    if (plan.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(
      WIDGET_KEY,
      buildTodoWidgetLines(plan, ctx.ui.theme),
      { placement: "aboveEditor" },
    );
  };

  const reconstructState = (ctx: ExtensionContext): void => {
    plan = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) {
        continue;
      }
      if (isTodoDetails(message.details)) {
        plan = clonePlan(message.details.plan);
      }
    }
    renderWidget(ctx);
  };

  const stateMessage = () => {
    const text = buildTodoContextText(plan);
    if (!text) return undefined;
    return {
      customType: CONTEXT_MESSAGE_TYPE,
      content: text,
      // Context only: the plan already has its own widget and tool cards.
      display: false,
      details: { plan: clonePlan(plan) } satisfies TodoDetails,
    };
  };

  pi.on("session_start", (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", (_event, ctx) => reconstructState(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    plan = [];
  });

  // Every round starts with the plan in view. The message is appended to the
  // conversation rather than folded into the system prompt on purpose: history
  // only ever grows, so the provider's prompt cache still hits, while a system
  // prompt that changed with the plan would invalidate the whole prefix.
  pi.on("before_agent_start", () => {
    const message = stateMessage();
    return message ? { message } : undefined;
  });

  // Safety net for context compaction. The appended message is normally still
  // in the window, and re-stating the plan on every request would cost the
  // conversation's prompt cache, so this only fires once compaction has
  // actually dropped the plan out of what the model can see.
  pi.on("context", (event) => {
    const message = stateMessage();
    if (!message) return undefined;
    if (samePlan(newestTodoStateInContext(event.messages), plan)) {
      return undefined;
    }
    return {
      messages: [
        ...event.messages,
        { role: "custom" as const, ...message, timestamp: Date.now() },
      ],
    };
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Todo",
    description:
      "更新并展示当前任务计划。每次必须提交完整有序列表；空数组表示清空。状态只能是 pending、in_progress、completed，最多一项为 in_progress。",
    promptSnippet: "todo: 更新并展示任务计划",
    promptGuidelines: [
      "多步骤任务需要展示进度时使用 todo；每次提交完整计划，并及时更新状态。",
    ],
    parameters: TodoParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validated = validateTodoPlan(params.plan);
      if ("error" in validated) {
        return {
          content: [{ type: "text", text: validated.error }],
          details: {
            plan: clonePlan(plan),
            error: validated.error,
          } satisfies TodoDetails,
          isError: true,
        };
      }

      plan = clonePlan(validated.plan);
      renderWidget(ctx);
      return {
        content: [{ type: "text", text: formatPlanForModel(plan) }],
        details: { plan: clonePlan(plan) } satisfies TodoDetails,
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("todo")) +
          theme.fg("muted", ` · ${args.plan.length} 项`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme: Theme) {
      const details = result.details as TodoDetails | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", details.error), 0, 0);
      }
      const currentPlan = details?.plan ?? [];
      return new Text(
        formatPlanForModel(currentPlan),
        0,
        0,
      );
    },
  });
}
