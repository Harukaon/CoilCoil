import type { JSONContent } from "@tiptap/core";
import type { PromptBrowserElementPart, PromptDocument, PromptPart } from "@coilcoil/runtime-protocol";

/**
 * PromptDocument（线性 parts）与 Tiptap JSON 之间的双向转换。
 *
 * text part 走 paragraph/text，browser-element pill 走 inline atom
 *（`browserElement`，见 tiptapPromptExtensions）。parts 是线性序列，
 *全部塞进一个 paragraph；空文档对应空 paragraph。
 */

export const BROWSER_ELEMENT_NODE = "browserElement";

export interface TiptapPromptEditorHandle {
  readonly element: HTMLElement | null;
  focus(): void;
  getCaretOffset(): number;
  setCaretOffset(offset: number): void;
  /** 在当前光标处插入一个网页元素（选中了一段时插在选区后面，不删用户的字），光标落在它后面。插入成功返回 true。 */
  insertBrowserElement?(part: PromptBrowserElementPart): boolean;
}

/*
 * 光标位置有两种算法，必须互相换算：
 * - 纯文本位置（caret offset）：输入框内容拼成一段文字时的第几个字。元素按名字算长度（「元素一」算 3 个字），
 *   换行算 1 个字，两个段落之间也算 1 个换行。斜杠菜单、拖路径、插入元素都用它。
 * - 编辑器位置（ProseMirror position）：元素、换行都只占 1 格，每个段落首尾各占 1 格。
 * 以前把元素在编辑器里也当成名字那么长，光标前每多一个元素，插入点就往前偏 2 个字。
 */
interface InlineNodeLike {
  readonly isText: boolean;
  readonly nodeSize: number;
  readonly text?: string | null;
  readonly type: { readonly name: string };
  readonly attrs: Record<string, unknown>;
}

interface BlockNodeLike {
  readonly content: { readonly size: number };
  forEach(callback: (child: InlineNodeLike, offset: number) => void): void;
}

export interface EditorDocLike {
  readonly content: { readonly size: number };
  forEach(callback: (child: BlockNodeLike, offset: number) => void): void;
}

/** 一个行内节点在纯文本里占几个字。 */
function inlineTextLength(node: InlineNodeLike): number {
  if (node.isText) return node.text?.length ?? 0;
  if (node.type.name === "hardBreak") return 1;
  if (node.type.name === BROWSER_ELEMENT_NODE) return typeof node.attrs.label === "string" ? node.attrs.label.length : 0;
  return 0;
}

/** 编辑器位置 → 纯文本位置。 */
export function caretOffsetAtPosition(doc: EditorDocLike, position: number): number {
  let offset = 0;
  let done = false;
  let index = 0;
  doc.forEach((block, blockPos) => {
    if (done) return;
    if (index++ > 0) {
      if (position <= blockPos) { done = true; return; }
      offset += 1;
    }
    const start = blockPos + 1;
    block.forEach((child, childOffset) => {
      if (done) return;
      const childStart = start + childOffset;
      if (position <= childStart) { done = true; return; }
      if (child.isText) {
        const taken = Math.min(child.nodeSize, position - childStart);
        offset += taken;
        if (taken < child.nodeSize) done = true;
      } else if (position >= childStart + child.nodeSize) {
        offset += inlineTextLength(child);
      } else {
        done = true;
      }
    });
    if (position <= start + block.content.size) done = true;
  });
  return offset;
}

/** 纯文本位置 → 编辑器位置。落在某个元素名字中间时，放到这个元素后面。 */
export function positionAtCaretOffset(doc: EditorDocLike, offset: number): number {
  let remaining = Math.max(0, offset);
  let result = -1;
  let lastEnd = 1;
  let index = 0;
  doc.forEach((block, blockPos) => {
    if (result >= 0) return;
    if (index++ > 0) {
      if (remaining <= 0) { result = lastEnd; return; }
      remaining -= 1;
    }
    const start = blockPos + 1;
    block.forEach((child, childOffset) => {
      if (result >= 0) return;
      const childStart = start + childOffset;
      if (child.isText) {
        if (remaining <= child.nodeSize) result = childStart + remaining;
        else remaining -= child.nodeSize;
        return;
      }
      if (remaining <= 0) { result = childStart; return; }
      const length = inlineTextLength(child);
      // 元素不能从中间拆开：落在名字中间就当作在它后面。
      if (remaining < length) { result = childStart + child.nodeSize; return; }
      remaining -= length;
    });
    lastEnd = start + block.content.size;
    if (result < 0 && remaining <= 0) result = lastEnd;
  });
  return result >= 0 ? result : lastEnd;
}

function textToInlineNodes(text: string): JSONContent[] {
  if (!text) return [];
  // 换行切成多个 text 节点，中间用 hardBreak 隔开。
  const lines = text.split("\n");
  const nodes: JSONContent[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (line) nodes.push({ type: "text", text: line });
  });
  return nodes;
}

export function promptDocumentToTiptap(document: PromptDocument): JSONContent {
  const content: JSONContent[] = [];
  for (const part of document.parts) {
    if (part.type === "text") {
      content.push(...textToInlineNodes(part.text));
    } else {
      content.push({
        type: BROWSER_ELEMENT_NODE,
        attrs: { id: part.id, label: part.label },
      });
    }
  }
  return {
    type: "doc",
    content: [{ type: "paragraph", content: content.length ? content : undefined }],
  };
}

function paragraphTextAndParts(paragraph: JSONContent, byId: Map<string, PromptBrowserElementPart>): { text: string; parts: PromptPart[] } {
  const parts: PromptPart[] = [];
  let text = "";
  const appendText = (value: string): void => {
    if (!value) return;
    text += value;
    const previous = parts.at(-1);
    if (previous?.type === "text") previous.text += value;
    else parts.push({ type: "text", text: value });
  };
  for (const node of paragraph.content ?? []) {
    if (node.type === "text") appendText(node.text ?? "");
    else if (node.type === BROWSER_ELEMENT_NODE) {
      const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
      const label = typeof node.attrs?.label === "string" ? node.attrs.label : "";
      const part = id ? byId.get(id) : undefined;
      if (part) parts.push(part);
      else if (label) {
        text += label;
        parts.push({ type: "text", text: label });
      }
    } else if (node.type === "hardBreak") appendText("\n");
  }
  return { text, parts };
}

/**
 * 编辑器内容 → PromptDocument。
 *
 * 编辑器里的元素只带编号和名字，截图、网页信息要按编号找回来：先找 `current`（当前文档），
 * 再找 `known`（这个输入框见过的全部元素）。剪切后粘贴、删掉后撤销，元素已经不在当前文档里，
 * 以前找不到就退化成一段普通文字，下一次插入还会把它们整段冲掉；有了 `known` 它们原样回来。
 */
export function tiptapToPromptDocument(
  content: JSONContent,
  current: PromptDocument,
  known?: ReadonlyMap<string, PromptBrowserElementPart>,
): { document: PromptDocument; text: string } {
  const byId = new Map<string, PromptBrowserElementPart>(known ?? []);
  for (const part of current.parts) if (part.type === "browser-element") byId.set(part.id, part);
  const parts: PromptPart[] = [];
  let text = "";
  const blocks = content.content ?? [];
  blocks.forEach((block, index) => {
    if (index > 0) {
      text += "\n";
      parts.push({ type: "text", text: "\n" });
    }
    if (block.type !== "paragraph") return;
    const parsed = paragraphTextAndParts(block, byId);
    text += parsed.text;
    for (const part of parsed.parts) {
      const previous = parts.at(-1);
      if (previous?.type === "text" && part.type === "text") previous.text += part.text;
      else parts.push(part);
    }
  });
  // 合并相邻 text，保持与 mergeTextParts 同一形状。
  const merged: PromptPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && !part.text) continue;
    const previous = merged.at(-1);
    if (previous?.type === "text" && part.type === "text") previous.text += part.text;
    else merged.push(part);
  }
  return { document: { version: 1, parts: merged }, text };
}

/** 文档的样子（文字和元素的先后），用来判断编辑器和外面的文档是不是同一份：只比文字会漏掉元素的变化。 */
export function promptDocumentSignature(document: PromptDocument): string {
  return document.parts.map((part) => part.type === "text" ? `t${part.text}` : `e${part.id}`).join("\u0000");
}
