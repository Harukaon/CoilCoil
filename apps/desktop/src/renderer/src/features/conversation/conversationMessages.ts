import type { ChatMessage } from "@suocode/runtime-protocol";

export interface PendingUserMessage {
  message: ChatMessage;
  sessionPath?: string;
}

export interface ConversationMessagesState {
  sessionPath?: string;
  revision: number;
  committed: ChatMessage[];
  pending: PendingUserMessage[];
}

export type ConversationMessagesAction =
  | { type: "reset"; sessionPath?: string; messages?: ChatMessage[] }
  | { type: "queue"; message: ChatMessage; sessionPath?: string }
  | { type: "bind_session"; id: string; sessionPath: string }
  | { type: "snapshot"; sessionPath: string; messages: ChatMessage[]; revision: number }
  | { type: "runtime_message"; message: ChatMessage; revision: number }
  | { type: "message_delta"; id: string; field: "text" | "thinking"; delta: string; timestamp: number; revision: number }
  | { type: "reject"; id: string; revision?: number }
  | { type: "truncate"; order: number }
  | { type: "restore"; state: ConversationMessagesState };

export const EMPTY_CONVERSATION_MESSAGES: ConversationMessagesState = {
  revision: 0,
  committed: [],
  pending: [],
};

function byOrder(left: ChatMessage, right: ChatMessage): number {
  return left.order - right.order || left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}

function upsert(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const withoutCurrent = messages.filter((item) => item.id !== message.id);
  return [...withoutCurrent, message].sort(byOrder);
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
      const pending = sameSession
        ? state.pending.filter((item) => item.sessionPath === action.sessionPath && !action.messages.some((message) => message.id === item.message.id))
        : [];
      return {
        sessionPath: action.sessionPath,
        revision: action.revision,
        committed: [...action.messages].sort(byOrder),
        pending,
      };
    }
    case "runtime_message":
      if (action.revision < state.revision) return state;
      return {
        ...state,
        revision: action.revision,
        committed: upsert(state.committed, action.message),
        pending: state.pending.filter((item) => item.message.id !== action.message.id),
      };
    case "message_delta": {
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
        pending: state.pending.filter((item) => item.message.id !== action.id),
      };
    case "truncate":
      return {
        ...state,
        committed: state.committed.filter((item) => item.order < action.order),
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

/** Project the committed runtime state and local sends into one stable list. */
export function selectConversationMessages(state: ConversationMessagesState): ChatMessage[] {
  let projected = [...state.committed];
  for (const item of state.pending) {
    if (item.sessionPath && item.sessionPath !== state.sessionPath) continue;
    projected = upsert(projected, item.message);
  }
  return projected;
}
