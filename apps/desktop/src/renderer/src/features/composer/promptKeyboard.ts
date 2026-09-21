export interface PromptKeyboardEventLike {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** React's SyntheticEvent carries the browser event here; Tiptap passes it directly. */
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

/**
 * Enter submits the composer unless it is an IME confirmation or Shift+Enter.
 * Tiptap supplies a native KeyboardEvent, while the legacy PromptEditor supplies
 * React's SyntheticEvent, so both shapes remain accepted during the migration.
 */
export function isPromptSendKey(event: PromptKeyboardEventLike): boolean {
  const nativeEvent = event.nativeEvent ?? event;
  return event.key === "Enter"
    && !event.shiftKey
    && nativeEvent.isComposing !== true
    && nativeEvent.keyCode !== 229;
}
