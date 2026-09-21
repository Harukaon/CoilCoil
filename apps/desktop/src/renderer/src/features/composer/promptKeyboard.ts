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
 * The footer editor is Tiptap-based and supplies a native KeyboardEvent, while
 * the inline editor still supplies React's SyntheticEvent, so both shapes are
 * intentionally accepted here.
 */
export function isPromptSendKey(event: PromptKeyboardEventLike): boolean {
  const nativeEvent = event.nativeEvent ?? event;
  return event.key === "Enter"
    && !event.shiftKey
    && nativeEvent.isComposing !== true
    && nativeEvent.keyCode !== 229;
}
