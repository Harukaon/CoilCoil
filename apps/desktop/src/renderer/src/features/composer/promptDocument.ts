import type {
  BrowserElementSnapshot,
  PromptBrowserElementPart,
  PromptDocument,
  PromptImage,
  PromptPart,
} from "@coilcoil/runtime-protocol";
import type { BrowserElementSelection } from "../../../../shared/desktop-api";

export function emptyPromptDocument(): PromptDocument {
  return { version: 1, parts: [] };
}

export function promptDocumentFromText(text: string): PromptDocument {
  return text ? { version: 1, parts: [{ type: "text", text }] } : emptyPromptDocument();
}

export function promptDocumentText(document: PromptDocument): string {
  return document.parts.map((part) => part.type === "text" ? part.text : part.label).join("");
}

export function promptDocumentHasText(document: PromptDocument): boolean {
  return document.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
}

export function promptDocumentHasContent(document: PromptDocument): boolean {
  return document.parts.some((part) => part.type === "browser-element" || part.text.trim().length > 0);
}

export function clonePromptDocument(document: PromptDocument): PromptDocument {
  return structuredClone(document);
}

export function browserElementSnapshot(selection: BrowserElementSelection): BrowserElementSnapshot {
  const {
    screenshot: _screenshot,
    ...snapshot
  } = selection;
  return snapshot;
}

const CHINESE_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 第几个元素叫什么：元素一 … 元素十，之后是 元素11、元素12。 */
export function browserElementLabel(ordinal: number): string {
  return `元素${ordinal >= 1 && ordinal <= 10 ? CHINESE_NUMERALS[ordinal - 1] : ordinal}`;
}

/** 从名字读回第几个；不是这种名字就是 0。 */
export function browserElementOrdinal(label: string): number {
  const name = /^元素(.+)$/.exec(label)?.[1];
  if (!name) return 0;
  const chinese = CHINESE_NUMERALS.indexOf(name);
  if (chinese >= 0) return chinese + 1;
  return /^\d+$/.test(name) ? Number(name) : 0;
}

/** 文档里编号最大的元素是第几个。 */
export function highestBrowserElementOrdinal(document: PromptDocument): number {
  return document.parts.reduce((highest, part) => part.type === "browser-element" ? Math.max(highest, browserElementOrdinal(part.label)) : highest, 0);
}

export function browserElementPart(
  selection: BrowserElementSelection,
  screenshotId?: string,
  ordinal = 1,
): PromptBrowserElementPart {
  return {
    type: "browser-element",
    id: globalThis.crypto?.randomUUID?.() ?? `browser-element-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: browserElementLabel(ordinal),
    element: browserElementSnapshot(selection),
    ...(screenshotId ? { screenshotId } : {}),
  };
}

function partLength(part: PromptPart): number {
  return part.type === "text" ? part.text.length : part.label.length;
}

/** Insert an atomic node at the editor's plain-text caret offset. */
export function insertPartAtOffset(document: PromptDocument, part: PromptPart, offset: number): PromptDocument {
  const clamped = Math.max(0, Math.min(offset, promptDocumentText(document).length));
  const next: PromptPart[] = [];
  let cursor = 0;
  let inserted = false;
  for (const current of document.parts) {
    const length = partLength(current);
    if (!inserted && clamped <= cursor + length) {
      if (current.type === "text") {
        const local = clamped - cursor;
        const before = current.text.slice(0, local);
        const after = current.text.slice(local);
        if (before) next.push({ type: "text", text: before });
        next.push(part);
        if (after) next.push({ type: "text", text: after });
      } else if (clamped <= cursor) {
        next.push(part, current);
      } else {
        next.push(current, part);
      }
      inserted = true;
    } else {
      next.push(current);
    }
    cursor += length;
  }
  if (!inserted) next.push(part);
  return mergeTextParts({ version: 1, parts: next });
}

export function replaceTextRange(
  document: PromptDocument,
  start: number,
  end: number,
  replacement: string,
): PromptDocument {
  const low = Math.max(0, Math.min(start, end));
  const high = Math.max(low, Math.max(start, end));
  const next: PromptPart[] = [];
  let cursor = 0;
  for (const part of document.parts) {
    const length = partLength(part);
    const partStart = cursor;
    const partEnd = cursor + length;
    if (partEnd <= low || partStart >= high) {
      next.push(part);
    } else if (part.type === "text") {
      const localStart = Math.max(0, low - partStart);
      const localEnd = Math.min(length, high - partStart);
      const before = part.text.slice(0, localStart);
      const after = part.text.slice(localEnd);
      if (before) next.push({ type: "text", text: before });
      if (after) next.push({ type: "text", text: after });
    }
    cursor = partEnd;
  }
  const result = mergeTextParts({ version: 1, parts: next });
  return replacement ? insertPartAtOffset(result, { type: "text", text: replacement }, low) : result;
}

export function removeBrowserElement(document: PromptDocument, id: string): PromptDocument {
  return mergeTextParts({ version: 1, parts: document.parts.filter((part) => part.type !== "browser-element" || part.id !== id) });
}

export function mergeTextParts(document: PromptDocument): PromptDocument {
  const parts: PromptPart[] = [];
  for (const part of document.parts) {
    if (part.type === "text" && !part.text) continue;
    const previous = parts.at(-1);
    if (previous?.type === "text" && part.type === "text") previous.text += part.text;
    else parts.push(part);
  }
  return { version: 1, parts };
}

export function imageForPromptPart(images: readonly PromptImage[], part: PromptBrowserElementPart): PromptImage | undefined {
  return part.screenshotId ? images.find((image) => image.id === part.screenshotId) : undefined;
}
