import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { PromptDocument } from "@coilcoil/runtime-protocol";
import { promptDocumentText } from "@coilcoil/runtime-protocol";
import { BrowserElementNode } from "./tiptapPromptExtensions";
import {
  BROWSER_ELEMENT_NODE,
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
 * 底部主输入框的 Tiptap 实现（Phase 1：只换 footer，inline 历史编辑保持旧版）。
 *
 * 与旧 PromptEditor 同一 handle 接口：focus/getCaretOffset/setCaretOffset，
 * caret offset 仍按纯文本长度（pill 算 label 长度），斜杠菜单可直接复用。
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
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      if (composingRef.current) return;
      const { document: next } = tiptapToPromptDocument(current.getJSON(), documentRef.current);
      onChangeRef.current(next);
    },
  });

  // 外部 document 变化（如斜杠菜单写入、pill 插入、会话切换）同步进编辑器。
  // 组字期间不碰：ProseMirror 自己管 preedit，等 compositionend 后再对账。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (composingRef.current) return;
    const next = promptDocumentToTiptap(documentValue);
    const currentText = promptDocumentText(tiptapToPromptDocument(editor.getJSON(), documentValue).document);
    if (currentText === promptDocumentText(documentValue)) return;
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
      const { document: next } = tiptapToPromptDocument(current.getJSON(), documentRef.current);
      onChangeRef.current(next);
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
      if (!editor || editor.isDestroyed) return promptDocumentText(documentRef.current).length;
      // ProseMirror pos 含 paragraph 开头 1 位；减掉后按“文本+hardBreak+atom label”折成纯文本 offset。
      const pos = editor.state.selection.from;
      let offset = 0;
      let remaining = Math.max(0, pos - 1);
      const walk = (node: { type: { name: string }; attrs?: Record<string, unknown>; text?: string; textContent: string; nodeSize: number; content?: { forEach: (fn: (child: never) => void) => void } }): boolean => {
        if (remaining <= 0) return true;
        if (node.type.name === "text") {
          const length = node.text?.length ?? 0;
          offset += Math.min(length, remaining);
          remaining -= length;
          return remaining <= 0;
        }
        if (node.type.name === "hardBreak") {
          offset += 1;
          remaining -= 1;
          return remaining <= 0;
        }
        if (node.type.name === BROWSER_ELEMENT_NODE) {
          const label = typeof node.attrs?.label === "string" ? node.attrs.label : node.textContent ?? "";
          const length = label.length;
          offset += Math.min(length, remaining);
          remaining -= length;
          return remaining <= 0;
        }
        node.content?.forEach((child) => {
          if (remaining > 0) {
            if (walk(child as never)) return;
          }
        });
        return remaining <= 0;
      };
      editor.state.doc.content.forEach((child) => {
        if (remaining > 0) walk(child as never);
      });
      return offset;
    },
    setCaretOffset: (offset) => {
      if (!editor || editor.isDestroyed) return;
      editor.commands.focus();
      try {
        const end = editor.state.doc.content.size - 1;
        editor.commands.setTextSelection(Math.max(1, Math.min(offset + 1, end)));
      } catch {
        editor.commands.focus("end");
      }
    },
  }), [editor]);

  return <EditorContent editor={editor} />;
});
