import type { ChatMessage, SubagentActivity, ToolRun } from "@suocode/runtime-protocol";
import type { ConversationTimelineItem, TimelineItem } from "./ConversationTimeline";

export function buildConversationTimeline(messages: ChatMessage[], tools: ToolRun[], subagents: SubagentActivity[] = []): ConversationTimelineItem[] {
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
    | { kind: "subagent"; order: number; activity: SubagentActivity };
  const ordered: OrderedItem[] = [
    ...messages
      .filter((message) => message.role !== "tool" && (message.text || message.thinking || message.images?.length))
      .map((message) => ({ kind: "message" as const, order: message.order, message })),
  ];
  for (const tool of tools) {
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
  for (const item of grouped) {
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
  return turns;
}
