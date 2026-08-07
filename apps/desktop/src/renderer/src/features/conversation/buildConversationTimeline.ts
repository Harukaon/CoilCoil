import type { ChatMessage, SubagentActivity, ToolRun } from "@suocode/runtime-protocol";
import type { ConversationTimelineItem, TimelineItem } from "./ConversationTimeline";

export function buildConversationTimeline(messages: ChatMessage[], tools: ToolRun[], subagents: SubagentActivity[]): ConversationTimelineItem[] {
  const ordered = [
    ...messages
      .filter((message) => message.role !== "tool" && (message.text || message.thinking || message.images?.length))
      .map((message) => ({ kind: "message" as const, order: message.order, message })),
    ...tools.map((tool) => tool.name === "subagent"
      ? {
          kind: "subagents" as const,
          order: tool.order,
          tool,
          subagents: subagents.filter((activity) => activity.parentToolId === tool.id || (!activity.parentToolId && activity.runId === tool.id)),
        }
      : { kind: "tool" as const, order: tool.order, tool }),
  ].sort((left, right) => left.order - right.order);

  const grouped: TimelineItem[] = [];
  for (const item of ordered) {
    if (item.kind === "tool") {
      const previous = grouped.at(-1);
      if (previous?.kind === "tools") previous.tools.push(item.tool);
      else grouped.push({ kind: "tools", order: item.order, tools: [item.tool] });
    } else if (item.kind === "subagents") {
      grouped.push(item);
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
