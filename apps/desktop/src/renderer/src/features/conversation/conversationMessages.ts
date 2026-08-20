import type { ChatMessage, QueuedPrompt } from "@coilcoil/runtime-protocol";

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
  | { type: "snapshot"; sessionPath: string; messages: ChatMessage[]; promptQueue?: QueuedPrompt[]; revision: number }
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

function upsert(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const withoutCurrent = messages.filter((item) => item.id !== message.id);
  return [...withoutCurrent, message].sort(byOrder);
}

function queuedMessages(queue: QueuedPrompt[]): ChatMessage[] {
  return queue.map((item) => ({
    id: item.id,
    order: item.queuedAt,
    role: "user",
    text: item.text,
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
      const pending = sameSession
        ? state.pending.filter((item) => item.sessionPath === action.sessionPath
          && !queuedIds.has(item.message.id)
          && !action.messages.some((message) => message.id === item.message.id))
        : [];
      return {
        sessionPath: action.sessionPath,
        revision: action.revision,
        committed: [...action.messages].sort(byOrder),
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
      return {
        ...state,
        revision: action.revision,
        committed: upsert(state.committed, action.message),
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
 * Project the committed runtime state and local sends into one stable list.
 *
 * Queued prompts are deliberately absent. They have not been sent, they can
 * still be withdrawn, and rendering them as chat bubbles claimed otherwise —
 * they belong above the input, where `selectQueuedPrompts` feeds them.
 */
export function selectConversationMessages(state: ConversationMessagesState): ChatMessage[] {
  let projected = [...state.committed];
  for (const item of state.pending) {
    if (item.sessionPath && item.sessionPath !== state.sessionPath) continue;
    projected = upsert(projected, item.message);
  }
  return projected;
}

/** The prompts waiting their turn, oldest first — the order they will be sent. */
export function selectQueuedPrompts(state: ConversationMessagesState): ChatMessage[] {
  return [...state.queued].sort(byOrder);
}
