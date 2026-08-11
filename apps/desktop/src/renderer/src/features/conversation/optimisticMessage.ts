import type { ChatMessage, PromptImage } from "@suocode/runtime-protocol";

export interface PendingOptimisticMessage {
  id: string;
  sessionPath?: string;
}

function sameImages(left: PromptImage[] | undefined, right: PromptImage[] | undefined): boolean {
  const first = left ?? [];
  const second = right ?? [];
  return first.length === second.length && first.every((image, index) => (
    image.mimeType === second[index]?.mimeType
    && image.data === second[index]?.data
    && image.name === second[index]?.name
  ));
}

/** Keep the first local user bubble while a newly created runtime still emits empty snapshots. */
export function reconcileOptimisticMessage(
  authoritative: ChatMessage[],
  current: ChatMessage[],
  pending: PendingOptimisticMessage | undefined,
  sessionPath: string,
): ChatMessage[] {
  if (!pending || pending.sessionPath !== sessionPath) return authoritative;
  const optimistic = current.find((message) => message.id === pending.id && message.role === "user");
  if (!optimistic) return authoritative;
  const replaced = authoritative.some((message) => (
    message.role === "user"
    && message.text === optimistic.text
    && sameImages(message.images, optimistic.images)
  ));
  if (replaced) return authoritative;
  return [...authoritative, optimistic].sort((left, right) => left.order - right.order);
}
