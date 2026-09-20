import type { ChatMessage, QueuedPrompt, SteeringMessage } from "@coilcoil/runtime-protocol";

export interface PendingUserMessage {
  message: ChatMessage;
  sessionPath?: string;
}

export interface ConversationMessagesState {
  sessionPath?: string;
  revision: number;
  committed: ChatMessage[];
  queued: ChatMessage[];
  pending: PendingUserMessage[];
}

export type ConversationMessagesAction =
  | { type: "reset"; sessionPath?: string; messages?: ChatMessage[] }
  | { type: "queue"; message: ChatMessage; sessionPath?: string }
  | { type: "bind_session"; id: string; sessionPath: string }
  | { type: "snapshot"; sessionPath: string; messages: ChatMessage[]; promptQueue?: QueuedPrompt[]; steering?: SteeringMessage[]; revision: number }
  | { type: "prompt_queue"; queue: QueuedPrompt[]; revision: number; sessionPath?: string }
  | { type: "runtime_message"; message: ChatMessage; revision: number; sessionPath?: string }
  | { type: "message_delta"; id: string; field: "text" | "thinking"; delta: string; timestamp: number; revision: number; sessionPath?: string }
  | { type: "reject"; id: string; revision?: number }
  | { type: "truncate"; order: number }
  | { type: "restore"; state: ConversationMessagesState };

export const EMPTY_CONVERSATION_MESSAGES: ConversationMessagesState = {
  revision: 0,
  committed: [],
  queued: [],
  pending: [],
};

function byOrder(left: ChatMessage, right: ChatMessage): number {
  return left.order - right.order || left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}

function preserveUserPromptMetadata(current: ChatMessage | undefined, next: ChatMessage): ChatMessage {
  if (!current || current.role !== "user" || next.role !== "user") return next;
  return {
    ...current,
    ...next,
    // Pi stores the model-facing serialization, not the editor's private node
    // document. Keep the local/history document if an authoritative event
    // arrives before the runtime metadata entry has been reconstructed.
    ...(next.promptDocument || current.promptDocument
      ? { promptDocument: next.promptDocument ?? current.promptDocument }
      : {}),
    ...(next.images || current.images
      ? { images: next.images ?? current.images }
      : {}),
  };
}

function upsert(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const current = messages.find((item) => item.id === message.id);
  const withoutCurrent = messages.filter((item) => item.id !== message.id);
  return [...withoutCurrent, preserveUserPromptMetadata(current, message)].sort(byOrder);
}

function queuedMessages(queue: QueuedPrompt[]): ChatMessage[] {
  return queue.map((item) => ({
    id: item.id,
    order: item.queuedAt,
    role: "user",
    text: item.text,
    promptDocument: item.promptDocument,
    images: item.images,
    timestamp: item.queuedAt,
    // A promoted entry stays in the queue until its steer actually lands, so the
    // row can show it leaving instead of vanishing into a gap with the message
    // neither queued nor yet in the transcript.
    status: item.promoting ? "running" : "queued",
  }));
}

/**
 * The reducer is the only writer for the rendered conversation timeline.
 * Runtime events may be replayed and React may evaluate updates repeatedly;
 * every action therefore has to be pure and idempotent.
 */
export function conversationMessagesReducer(
  state: ConversationMessagesState,
  action: ConversationMessagesAction,
): ConversationMessagesState {
  switch (action.type) {
    case "reset":
      return {
        sessionPath: action.sessionPath,
        revision: 0,
        committed: [...(action.messages ?? [])].sort(byOrder),
        queued: [],
        pending: [],
      };
    case "queue": {
      const pending = state.pending.filter((item) => item.message.id !== action.message.id);
      pending.push({ message: action.message, sessionPath: action.sessionPath });
      return { ...state, pending };
    }
    case "bind_session":
      return {
        ...state,
        sessionPath: action.sessionPath,
        pending: state.pending.map((item) => item.message.id === action.id
          ? { ...item, sessionPath: action.sessionPath }
          : item),
      };
    case "snapshot": {
      const sameSession = state.sessionPath === action.sessionPath;
      if (sameSession && action.revision < state.revision) return state;
      const queued = queuedMessages(action.promptQueue ?? []);
      const queuedIds = new Set(queued.map((message) => message.id));
      /* 介入消息既不在队列里也不在记录里，切走时本地那份 pending 就没了。快照
         现在带着它们（SessionSnapshot.steering），所以切回来要按快照重建，而不是
         清空——否则介入照常生效，界面上却看不到，用户「切换了一次界面之后就看不
         到了」说的就是这里。 */
      const restored = (action.steering ?? []).map((item) => ({
        message: {
          id: item.id,
          order: item.timestamp,
          role: "user" as const,
          text: item.text,
          promptDocument: item.promptDocument,
          images: item.images,
          timestamp: item.timestamp,
          status: "steering" as const,
        },
        sessionPath: action.sessionPath,
      }));
      const restoredIds = new Set(restored.map((item) => item.message.id));
      const carried = sameSession
        ? state.pending.filter((item) => item.sessionPath === action.sessionPath
          && !restoredIds.has(item.message.id)
          && !queuedIds.has(item.message.id)
          && !action.messages.some((message) => message.id === item.message.id))
        : [];
      const pending = [
        ...carried,
        ...restored.filter((item) => !queuedIds.has(item.message.id)
          && !action.messages.some((message) => message.id === item.message.id)),
      ];
      const previousById = new Map<string, ChatMessage>([
        ...state.committed,
        ...state.pending.map((item) => item.message),
      ].map((message) => [message.id, message]));
      return {
        sessionPath: action.sessionPath,
        revision: action.revision,
        committed: action.messages.map((message) => preserveUserPromptMetadata(previousById.get(message.id), message)).sort(byOrder),
        queued,
        pending,
      };
    }
    case "prompt_queue": {
      if (action.sessionPath && state.sessionPath && action.sessionPath !== state.sessionPath) return state;
      if (action.revision < state.revision) return state;
      const queued = queuedMessages(action.queue);
      const queuedIds = new Set(queued.map((message) => message.id));
      return {
        ...state,
        revision: action.revision,
        queued,
        pending: state.pending.filter((item) => !queuedIds.has(item.message.id)),
      };
    }
    case "runtime_message":
      if (action.sessionPath && state.sessionPath && action.sessionPath !== state.sessionPath) return state;
      if (action.revision < state.revision) return state;
      const existing = state.committed.find((message) => message.id === action.message.id)
        ?? state.pending.find((item) => item.message.id === action.message.id)?.message;
      return {
        ...state,
        revision: action.revision,
        committed: upsert(state.committed, preserveUserPromptMetadata(existing, action.message)),
        queued: state.queued.filter((message) => message.id !== action.message.id),
        pending: state.pending.filter((item) => item.message.id !== action.message.id),
      };
    case "message_delta": {
      if (action.sessionPath && state.sessionPath && action.sessionPath !== state.sessionPath) return state;
      if (action.revision < state.revision) return state;
      const current = state.committed.find((message) => message.id === action.id);
      const message: ChatMessage = current
        ? {
            ...current,
            [action.field]: `${action.field === "thinking" ? current.thinking ?? "" : current.text}${action.delta}`,
            status: "running",
          }
        : {
            id: action.id,
            order: action.timestamp,
            role: "assistant",
            text: action.field === "text" ? action.delta : "",
            thinking: action.field === "thinking" ? action.delta : undefined,
            timestamp: action.timestamp,
            status: "running",
          };
      return { ...state, revision: action.revision, committed: upsert(state.committed, message) };
    }
    case "reject":
      return {
        ...state,
        revision: Math.max(state.revision, action.revision ?? state.revision),
        queued: state.queued.filter((message) => message.id !== action.id),
        pending: state.pending.filter((item) => item.message.id !== action.id),
      };
    case "truncate":
      return {
        ...state,
        committed: state.committed.filter((item) => item.order < action.order),
        queued: [],
        pending: [],
      };
    case "restore":
      return action.state;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/**
 * The transcript as rendered: what Pi has committed, plus what is on its way.
 *
 * Queued prompts are deliberately absent. They sit above the composer where they
 * can be withdrawn or interjected, and drawing them in the transcript as well
 * claimed they had been sent when they had not. A steered message is the
 * opposite case: Pi has taken it, nothing can withdraw it, and it only reaches
 * the model when the running turn ends - so it is shown here, marked, for that
 * whole stretch rather than disappearing until the turn is over.
 */
export function selectConversationMessages(state: ConversationMessagesState): ChatMessage[] {
  let projected = [...state.committed];
  const confirmed = new Set(projected.map((message) => message.id));
  for (const item of state.pending) {
    if (item.sessionPath && item.sessionPath !== state.sessionPath) continue;
    if (confirmed.has(item.message.id)) continue;
    projected = upsert(projected, item.message);
  }
  return projected;
}

/** The prompts waiting their turn, oldest first — the order they will be sent. */
export function selectQueuedPrompts(state: ConversationMessagesState): ChatMessage[] {
  return [...state.queued].sort(byOrder);
}
