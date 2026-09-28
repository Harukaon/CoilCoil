import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { ClipboardEvent, FormEvent, KeyboardEvent } from "react";
import type { PromptBrowserElementPart, PromptDocument, PromptPart } from "@coilcoil/runtime-protocol";
import {
  mergeTextParts,
  promptDocumentText,
  removeBrowserElement,
  replaceTextRange,
} from "./promptDocument";

export interface PromptEditorHandle {
  readonly element: HTMLElement | null;
  focus(): void;
  getCaretOffset(): number;
  setCaretOffset(offset: number): void;
  /** 在光标处插入一个网页元素，光标落在它后面；插入成功返回 true（见 TiptapPromptEditor）。 */
  insertBrowserElement?(part: PromptBrowserElementPart): boolean;
}

interface PromptEditorProps {
  document: PromptDocument;
  onChange: (document: PromptDocument) => void;
  onPasteImages: (event: ClipboardEvent<HTMLDivElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder: string;
  ariaLabel: string;
}

function atomicElement(target: Node | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest<HTMLElement>("[data-prompt-element-id]") ?? undefined;
}

function editorTextBefore(editor: HTMLElement, container: Node, offset: number): string {
  const range = document.createRange();
  range.selectNodeContents(editor);
  try {
    range.setEnd(container, offset);
  } catch {
    return promptDocumentText({ version: 1, parts: [] });
  }
  return range.toString();
}

function caretOffset(editor: HTMLElement, documentValue: PromptDocument): number {
  const selection = globalThis.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return promptDocumentText(documentValue).length;
  const range = selection.getRangeAt(0);
  return editorTextBefore(editor, range.startContainer, range.startOffset).length;
}

function leafNodes(editor: HTMLElement): Array<{ node: Node; start: number; end: number; atomic?: boolean }> {
  const leaves: Array<{ node: Node; start: number; end: number; atomic?: boolean }> = [];
  let cursor = 0;
  const visit = (node: Node): void => {
    if (node instanceof HTMLElement && node.dataset.promptElementId) {
      const length = node.textContent?.length ?? 0;
      leaves.push({ node, start: cursor, end: cursor + length, atomic: true });
      cursor += length;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      leaves.push({ node, start: cursor, end: cursor + length });
      cursor += length;
      return;
    }
    if (node instanceof HTMLElement && node.tagName === "BR") {
      leaves.push({ node, start: cursor, end: cursor + 1 });
      cursor += 1;
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of editor.childNodes) visit(child);
  return leaves;
}

function setCaret(editor: HTMLElement, documentValue: PromptDocument, offset: number): void {
  const target = Math.max(0, Math.min(offset, promptDocumentText(documentValue).length));
  const selection = globalThis.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const leaves = leafNodes(editor);
  const leaf = leaves.find((item) => target >= item.start && target < item.end);
  if (leaf?.atomic) {
    if (target - leaf.start < (leaf.end - leaf.start) / 2) range.setStartBefore(leaf.node);
    else range.setStartAfter(leaf.node);
  } else if (leaf?.node.nodeType === Node.TEXT_NODE) {
    range.setStart(leaf.node, target - leaf.start);
  } else if (target === 0 && editor.firstChild) {
    range.setStartBefore(editor.firstChild);
  } else if (editor.lastChild) {
    range.setStartAfter(editor.lastChild);
  } else {
    range.setStart(editor, 0);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function parseEditor(editor: HTMLElement, current: PromptDocument): PromptDocument {
  const byId = new Map(current.parts.filter((part) => part.type === "browser-element").map((part) => [part.id, part]));
  const parts: PromptPart[] = [];
  const appendText = (text: string): void => {
    if (!text) return;
    parts.push({ type: "text", text });
  };
  const visit = (node: Node): void => {
    if (node instanceof HTMLElement && node.dataset.promptElementId) {
      const part = byId.get(node.dataset.promptElementId);
      if (part) parts.push(part);
      else appendText(node.textContent ?? "");
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (node instanceof HTMLElement && node.tagName === "BR") {
      appendText("\n");
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of editor.childNodes) visit(child);
  return mergeTextParts({ version: 1, parts });
}

function documentKey(documentValue: PromptDocument): string {
  return JSON.stringify(documentValue);
}

function renderDocument(editor: HTMLElement, documentValue: PromptDocument): void {
  const fragment = document.createDocumentFragment();
  for (const part of documentValue.parts) {
    if (part.type === "text") {
      fragment.append(document.createTextNode(part.text));
      continue;
    }
    const element = document.createElement("span");
    element.className = "prompt-editor-element";
    element.dataset.promptElementId = part.id;
    element.contentEditable = "false";
    element.spellcheck = false;
    element.title = `${part.element.pageTitle || "网页元素"}\n${part.element.selector}`;
    element.textContent = part.label;
    fragment.append(element);
  }
  editor.replaceChildren(fragment);
}

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor({
  document: documentValue,
  onChange,
  onPasteImages,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  disabled,
  autoFocus,
  placeholder,
  ariaLabel,
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef(documentValue);
  const renderedKeyRef = useRef<string | undefined>(undefined);
  const pendingCaretRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  documentRef.current = documentValue;

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const key = documentKey(documentValue);
    if (renderedKeyRef.current === key) return;
    const wasFocused = globalThis.document.activeElement === editor;
    const offset = wasFocused
      ? pendingCaretRef.current ?? caretOffset(editor, documentRef.current)
      : null;
    renderDocument(editor, documentValue);
    renderedKeyRef.current = key;
    pendingCaretRef.current = null;
    if (wasFocused && offset !== null) {
      requestAnimationFrame(() => {
        if (globalThis.document.activeElement === editor) setCaret(editor, documentValue, offset);
      });
    }
  }, [documentValue]);

  useImperativeHandle(ref, () => ({
    get element() { return editorRef.current; },
    focus: () => editorRef.current?.focus(),
    getCaretOffset: () => editorRef.current ? caretOffset(editorRef.current, documentRef.current) : promptDocumentText(documentRef.current).length,
    setCaretOffset: (offset) => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      setCaret(editorRef.current, documentRef.current, offset);
    },
  }), []);

  const commitDomValue = (): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const offset = caretOffset(editor, documentRef.current);
    const next = parseEditor(editor, documentRef.current);
    pendingCaretRef.current = offset;
    onChange(next);
  };

  const handleInput = (event: FormEvent<HTMLDivElement>): void => {
    if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
    commitDomValue();
  };

  const handleCompositionStart = (): void => {
    composingRef.current = true;
    onCompositionStart();
  };

  const handleCompositionEnd = (): void => {
    composingRef.current = false;
    onCompositionEnd();
    // Chromium normally emits the committed `input` immediately after
    // compositionend. The frame fallback also covers IMEs that only expose
    // the final text during the next paint, while keeping the preedit DOM
    // untouched for the whole composition.
    requestAnimationFrame(() => {
      if (!composingRef.current) commitDomValue();
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!event.defaultPrevented && (event.key === "Backspace" || event.key === "Delete")) {
      const editor = editorRef.current;
      const selection = globalThis.getSelection();
      if (editor && selection?.isCollapsed && selection.rangeCount) {
        const offset = caretOffset(editor, documentRef.current);
        const text = promptDocumentText(documentRef.current);
        const low = event.key === "Backspace" ? Math.max(0, offset - 1) : offset;
        const high = event.key === "Backspace" ? offset : Math.min(text.length, offset + 1);
        let cursor = 0;
        const target = documentRef.current.parts.find((part) => {
          const length = part.type === "text" ? part.text.length : part.label.length;
          const matches = part.type === "browser-element" && low < cursor + length && high > cursor;
          cursor += length;
          return matches;
        });
        if (target?.type === "browser-element") {
          event.preventDefault();
          const nextOffset = event.key === "Backspace" ? Math.max(0, offset - target.label.length) : offset;
          pendingCaretRef.current = nextOffset;
          onChange(removeBrowserElement(documentRef.current, target.id));
          return;
        }
      }
    }
    onKeyDown(event);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      onPasteImages(event);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const editor = editorRef.current;
    if (!editor) return;
    const offset = caretOffset(editor, documentRef.current);
    const next = replaceTextRange(documentRef.current, offset, offset, text);
    pendingCaretRef.current = offset + text.length;
    onChange(next);
  };

  return (
    <div
      ref={editorRef}
      className="prompt-editor"
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-label={ariaLabel}
      data-placeholder={placeholder}
      spellCheck={false}
      autoFocus={autoFocus}
      onInput={handleInput}
      onPaste={handlePaste}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onKeyDown={handleKeyDown}
    />
  );
});
