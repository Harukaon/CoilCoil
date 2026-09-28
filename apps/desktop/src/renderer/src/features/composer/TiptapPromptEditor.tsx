import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import type { PromptBrowserElementPart, PromptDocument } from "@coilcoil/runtime-protocol";
import { BrowserElementNode } from "./tiptapPromptExtensions";
import {
  BROWSER_ELEMENT_NODE,
  caretOffsetAtPosition,
  positionAtCaretOffset,
  promptDocumentSignature,
  promptDocumentToTiptap,
  tiptapToPromptDocument,
  type TiptapPromptEditorHandle,
} from "./tiptapPromptDocument";

interface TiptapPromptEditorProps {
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

/**
 * 主输入框和历史消息编辑态共用的 Tiptap 实现。
 *
 * 与旧 PromptEditor 同一 handle 接口：focus/getCaretOffset/setCaretOffset，
 * caret offset 仍按纯文本长度（pill 算 label 长度），斜杠菜单可直接复用；和编辑器位置的换算见
 * tiptapPromptDocument.ts（pill 在编辑器里只占 1 格）。
 * 组字保护由 ProseMirror 内置 IME 集成接管，不再手写整树重渲染。
 */
export const TiptapPromptEditor = forwardRef<TiptapPromptEditorHandle, TiptapPromptEditorProps>(function TiptapPromptEditor({
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
  const documentRef = useRef(documentValue);
  documentRef.current = documentValue;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const composingRef = useRef(false);
  // 这个输入框见过的全部元素（按编号）。剪切后粘贴、删掉后撤销，元素回到编辑器里时靠它找回截图和网页信息。
  const knownPartsRef = useRef(new Map<string, PromptBrowserElementPart>());
  for (const part of documentValue.parts) if (part.type === "browser-element") knownPartsRef.current.set(part.id, part);
  const toDocument = (content: Parameters<typeof tiptapToPromptDocument>[0]): PromptDocument =>
    tiptapToPromptDocument(content, documentRef.current, knownPartsRef.current).document;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // 输入框只要段落/文本/历史/按键：标题、列表、引用等全部关掉。
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        hardBreak: { keepMarks: false },
      }),
      BrowserElementNode,
      // 空文档时显示 data-placeholder：Tiptap 空段落里有 <br>，:empty 永远不成立，
      // 必须用官方 Placeholder 扩展（往空段落打 .is-empty 标记 + data-placeholder）。
      Placeholder.configure({ placeholder }),
    ],
    content: promptDocumentToTiptap(documentValue),
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        class: "prompt-editor tiptap",
        role: "textbox",
        "aria-label": ariaLabel,
        "data-placeholder": placeholder,
        spellcheck: "false",
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
        if (files.length) {
          onPasteImages(event as unknown as ClipboardEvent<HTMLDivElement>);
          return true;
        }
        return false;
      },
      handleKeyDown: (_view, event) => {
        onKeyDown(event as unknown as KeyboardEvent<HTMLDivElement>);
        // Let ProseMirror know when the composer already handled the key.
        // This preserves Shift+Enter's hard break while preventing a second
        // paragraph after submit, slash selection, or Escape.
        return event.defaultPrevented;
      },
    },
    onUpdate: ({ editor: current }) => {
      if (composingRef.current) return;
      onChangeRef.current(toDocument(current.getJSON()));
    },
  });

  // 外部 document 变化（如斜杠菜单写入、pill 插入、会话切换）同步进编辑器。
  // 组字期间不碰：ProseMirror 自己管 preedit，等 compositionend 后再对账。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (composingRef.current) return;
    const next = promptDocumentToTiptap(documentValue);
    // 连元素一起比：只比文字的话，元素变成同名文字这种变化会被当成「没变」。
    const current = tiptapToPromptDocument(editor.getJSON(), documentValue, knownPartsRef.current).document;
    if (promptDocumentSignature(current) === promptDocumentSignature(documentValue)) return;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(next);
    try {
      const end = editor.state.doc.content.size - 1;
      const at = Math.max(1, Math.min(Math.max(from, to), end));
      editor.commands.setTextSelection(at);
    } catch {
      // 空文档或边界位置：落在末尾即可。
    }
  }, [editor, documentValue]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const start = (): void => {
      composingRef.current = true;
      onCompositionStart();
    };
    const end = (): void => {
      composingRef.current = false;
      onCompositionEnd();
      // 组字结束后对一次账：把提交后的最终文本同步给外部。
      const current = editor;
      if (!current || current.isDestroyed) return;
      onChangeRef.current(toDocument(current.getJSON()));
    };
    dom.addEventListener("compositionstart", start);
    dom.addEventListener("compositionend", end);
    return () => {
      dom.removeEventListener("compositionstart", start);
      dom.removeEventListener("compositionend", end);
    };
  }, [editor, onCompositionStart, onCompositionEnd]);

  useImperativeHandle(ref, () => ({
    get element() { return editor?.view.dom ?? null; },
    focus: () => editor?.commands.focus(),
    getCaretOffset: () => {
      if (!editor || editor.isDestroyed) return documentRef.current.parts.reduce((length, part) => length + (part.type === "text" ? part.text.length : part.label.length), 0);
      return caretOffsetAtPosition(editor.state.doc, editor.state.selection.from);
    },
    setCaretOffset: (offset) => {
      if (!editor || editor.isDestroyed) return;
      editor.commands.focus();
      try {
        editor.commands.setTextSelection(positionAtCaretOffset(editor.state.doc, offset));
      } catch {
        editor.commands.focus("end");
      }
    },
    insertBrowserElement: (part) => {
      if (!editor || editor.isDestroyed) return false;
      knownPartsRef.current.set(part.id, part);
      // 直接在编辑器里插：不再「按纯文本位置重建整段内容、等下一帧再摆光标」，那样位置会算错、
      // 光标也会被随后的整段替换放回原处。插在选区末尾，用户选中的字不删；插完光标就在它后面。
      const at = editor.state.selection.to;
      return editor.chain()
        .focus()
        .insertContentAt(at, { type: BROWSER_ELEMENT_NODE, attrs: { id: part.id, label: part.label } })
        .run();
    },
  }), [editor]);

  return <EditorContent editor={editor} />;
});
