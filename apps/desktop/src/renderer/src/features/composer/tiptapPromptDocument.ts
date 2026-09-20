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

export function tiptapToPromptDocument(
  content: JSONContent,
  current: PromptDocument,
): { document: PromptDocument; text: string } {
  const byId = new Map(
    current.parts.filter((part) => part.type === "browser-element").map((part) => [part.id, part]),
  );
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
