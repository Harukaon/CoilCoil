import type { ChatMessage, ToolRun } from "@suocode/runtime-protocol";
import type { ConversationTimelineItem, TimelineItem } from "./ConversationTimeline";

export function buildConversationTimeline(messages: ChatMessage[], tools: ToolRun[]): ConversationTimelineItem[] {
  const ordered = [
    ...messages
      .filter((message) => message.role !== "tool" && (message.text || message.thinking || message.images?.length))
      .map((message) => ({ kind: "message" as const, order: message.order, message })),
    ...tools.map((tool) => ({ kind: "tool" as const, order: tool.order, tool })),
  ].sort((left, right) => left.order - right.order);

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
    const previous = turns.at(-1);
    if (previous?.kind === "agent") previous.items.push(item);
    else turns.push({ kind: "agent", order: item.order, items: [item] });
  }
  return turns;
}
