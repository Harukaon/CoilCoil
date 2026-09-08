import type { ChatMessage, PlanApprovalState, RuntimeInspectionSnapshot, SubagentActivity, ToolRun } from "@coilcoil/runtime-protocol";
import { buildCompactionMarks } from "./compactionMarks";
import type { ConversationTimelineItem, TimelineItem } from "./ConversationTimeline";

export function buildConversationTimeline(
  messages: ChatMessage[],
  tools: ToolRun[],
  subagents: SubagentActivity[] = [],
  planApproval?: PlanApprovalState,
  // Compaction marks are derived here rather than passed in: they come entirely
  // from the inspection snapshot the caller already holds, and deriving them
  // beside the timeline keeps the two orderings from drifting apart.
  inspection?: Pick<RuntimeInspectionSnapshot, "summaryEvents" | "contextClearings">,
): ConversationTimelineItem[] {
  const compactionMarks = buildCompactionMarks(messages, inspection?.summaryEvents, inspection?.contextClearings);
  const subagentsByParent = new Map<string, SubagentActivity[]>();
  for (const activity of subagents) {
    const parent = activity.parentToolId ?? activity.runId;
    const group = subagentsByParent.get(parent) ?? [];
    group.push(activity);
    subagentsByParent.set(parent, group);
  }
  type OrderedItem =
    | { kind: "message"; order: number; message: ChatMessage }
    | { kind: "tool"; order: number; tool: ToolRun }
    | { kind: "plan"; order: number; plan: PlanApprovalState }
    | { kind: "subagent"; order: number; activity: SubagentActivity };
  const ordered: OrderedItem[] = [
    ...messages
      .filter((message) => message.role !== "tool" && (message.text || message.thinking || message.images?.length))
      .map((message) => ({ kind: "message" as const, order: message.order, message })),
  ];
  const latestPlanTool = [...tools].filter((tool) => tool.name === "plan").sort((left, right) => right.order - left.order)[0];
  for (const tool of tools) {
    if (planApproval && latestPlanTool?.id === tool.id) {
      ordered.push({ kind: "plan", order: tool.order, plan: planApproval });
      continue;
    }
    const activities = tool.name === "subagent" ? subagentsByParent.get(tool.id) ?? [] : [];
    if (!activities.length) {
      ordered.push({ kind: "tool", order: tool.order, tool });
      continue;
    }
    activities
      .sort((left, right) => left.index - right.index || left.updatedAt - right.updatedAt)
      .forEach((activity, index) => ordered.push({ kind: "subagent", order: tool.order + index / 1000, activity }));
  }
  ordered.sort((left, right) => left.order - right.order);

  const grouped: TimelineItem[] = [];
  for (const item of ordered) {
    if (item.kind === "tool") {
      const previous = grouped.at(-1);
      if (previous?.kind === "tools") previous.tools.push(item.tool);
      else grouped.push({ kind: "tools", order: item.order, tools: [item.tool] });
    } else {
      grouped.push(item);
    }
  }

  const turns: ConversationTimelineItem[] = [];
  // A compaction rule is a divider, never part of a turn: whatever follows it is
  // a fresh turn, because the model's view of everything above just changed.
  const pending = [...compactionMarks].sort((left, right) => left.order - right.order);
  const drainMarksBefore = (order: number): void => {
    while (pending.length && pending[0].order <= order) {
      const mark = pending.shift()!;
      turns.push({ kind: "compaction", order: mark.order, mark });
    }
  };
  for (const item of grouped) {
    drainMarksBefore(item.order);
    if (item.kind === "message" && item.message.role === "user") {
      turns.push({ kind: "user", order: item.order, message: item.message });
      continue;
    }
    const model = item.kind === "message" && item.message.role === "assistant" ? item.message.model : undefined;
    const previous = turns.at(-1);
    if (previous?.kind === "agent") {
      previous.items.push(item);
      previous.model ??= model;
    } else turns.push({ kind: "agent", order: item.order, items: [item], model });
  }
  drainMarksBefore(Number.POSITIVE_INFINITY);
  return turns;
}
