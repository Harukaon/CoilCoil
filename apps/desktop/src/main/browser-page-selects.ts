import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { BrowserPageEvent, BrowserSelectPicker } from "../shared/desktop-api";

/**
 * 离屏页面里的原生下拉弹层在 Mac 上无法显示。只截住用户打开单选下拉框的动作，
 * 让面板画出选项；列表式、多选仍由网页自己处理。AI 的 fill/select 工具照常工作。
 * 命中检查只读，不在超时、切页后悄悄改变网页焦点。
 */
const OPTIONS = `(select) => [...select.options].slice(0, 2000).map((option) => ({
  label: option.label || option.text,
  value: option.value,
  disabled: option.disabled || Boolean(option.parentElement && option.parentElement.disabled),
  group: option.parentElement && option.parentElement.tagName === "OPTGROUP" ? option.parentElement.label : "",
}))`;
const READ_SELECT = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement;
  const select = element && element.closest ? element.closest("select") : null;
  if (!select || !select.isConnected || select.multiple || select.size > 1 || select.disabled) return null;
  const rect = select.getBoundingClientRect();
  let x = rect.x, y = rect.y;
  // 同源内嵌页面的坐标要加上每层 frame 的偏移。
  try {
    let view = select.ownerDocument.defaultView;
    while (view && view.frameElement) {
      const frame = view.frameElement, box = frame.getBoundingClientRect();
      x += box.x + frame.clientLeft; y += box.y + frame.clientTop;
      view = frame.ownerDocument.defaultView;
    }
  } catch {}
  return { rect: { x, y, width: rect.width, height: rect.height },
    selectedIndex: select.selectedIndex, options: (${OPTIONS})(select) };
}`;
const WRITE_SELECT = `function (index, expected) {
  const select = this.closest && this.closest("select");
  if (!select || !select.isConnected || select.disabled || select.multiple || select.size > 1) return false;
  // 页面可能已被用户或 AI 改过。旧列表里的「第 2 项」不能写成新列表里的另一项。
  const options = (${OPTIONS})(select);
  if (options.length !== expected.length || options.some((option, i) =>
    ["label", "value", "disabled", "group"].some((key) => option[key] !== expected[i][key]))
    || !options[index] || options[index].disabled) return false;
  if (select.selectedIndex === index) return true;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;
const FOCUSED_ELEMENT = `(() => {
  let element = document.activeElement;
  while (element) {
    const nested = element.shadowRoot && element.shadowRoot.activeElement;
    if (nested) { element = nested; continue; }
    try { if (element.contentDocument && element.contentDocument.activeElement) { element = element.contentDocument.activeElement; continue; } } catch {}
    break;
  }
  return element;
})()`;

interface OpenSelect {
  id: string;
  backendNodeId: number;
  contents: WebContents;
  picker: Omit<BrowserSelectPicker, "id">;
}

export class PageSelects {
  private readonly open = new Map<string, OpenSelect>();
  private readonly requests = new Map<string, object>();
  private readonly watched = new WeakSet<WebContents>();

  constructor(
    private readonly publish: (event: BrowserPageEvent) => void,
    private readonly isCurrent: (tabId: string, contents: WebContents) => boolean = () => true,
    private readonly budgetMs = 150,
  ) {}

  /** point 缺省表示键盘打开当前有焦点的下拉框。 */
  async intercept(tabId: string, contents: WebContents, point?: { x: number; y: number }): Promise<boolean> {
    this.watch(tabId, contents);
    this.forget(tabId);
    const request = {};
    this.requests.set(tabId, request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([
        this.read(contents, point),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), this.budgetMs); }),
      ]);
      if (this.requests.get(tabId) !== request || !this.isCurrent(tabId, contents)) return true;
      if (!found || contents.isDestroyed()) return false;
      // 只有仍有效的用户操作才改变焦点；过期命中结果不会补弹列表或偷焦点。
      await contents.debugger.sendCommand("DOM.focus", { backendNodeId: found.backendNodeId });
      if (this.requests.get(tabId) !== request || !this.isCurrent(tabId, contents)) return true;
      const id = randomUUID();
      this.open.set(tabId, { id, contents, ...found });
      this.publish({ tabId, kind: "select", picker: { id, ...found.picker } });
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.requests.get(tabId) === request) this.requests.delete(tabId);
    }
  }

  async choose(tabId: string, pickerId: string, index: number | null): Promise<void> {
    const open = this.open.get(tabId);
    if (!open || open.id !== pickerId) return;
    this.forget(tabId);
    if (index === null || !Number.isInteger(index) || index < 0 || index >= open.picker.options.length
      || open.contents.isDestroyed() || !this.isCurrent(tabId, open.contents)) return;
    const debug = open.contents.debugger;
    let objectId: string | undefined;
    try {
      const { object } = await debug.sendCommand("DOM.resolveNode", { backendNodeId: open.backendNodeId });
      objectId = object?.objectId;
      if (!objectId || !this.isCurrent(tabId, open.contents)) return;
      await debug.sendCommand("Runtime.callFunctionOn", {
        objectId, functionDeclaration: WRITE_SELECT,
        arguments: [{ value: index }, { value: open.picker.options }],
      });
    } catch {
      // 选择过程中页面跳走、元素删除：放弃旧选择，不能写进另一张页面。
    } finally {
      if (objectId) await debug.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  forget(tabId: string): void {
    this.requests.delete(tabId);
    if (this.open.delete(tabId)) this.publish({ tabId, kind: "select", picker: null });
  }

  private watch(tabId: string, contents: WebContents): void {
    if (this.watched.has(contents)) return;
    this.watched.add(contents);
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.forget(tabId);
    });
    contents.on("did-navigate-in-page", () => this.forget(tabId));
    contents.once("destroyed", () => this.forget(tabId));
  }

  private async read(contents: WebContents, point?: { x: number; y: number }): Promise<Pick<OpenSelect, "backendNodeId" | "picker"> | undefined> {
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return undefined;
    const debug = contents.debugger;
    const zoom = contents.getZoomFactor() || 1;
    let objectId: string | undefined;
    try {
      let backendNodeId: number;
      if (point) {
        const at = await debug.sendCommand("DOM.getNodeForLocation", {
          x: Math.round(point.x / zoom), y: Math.round(point.y / zoom), includeUserAgentShadowDOM: false,
        });
        backendNodeId = at.backendNodeId;
        const { object } = await debug.sendCommand("DOM.resolveNode", { backendNodeId });
        objectId = object?.objectId;
      } else {
        const { result } = await debug.sendCommand("Runtime.evaluate", { expression: FOCUSED_ELEMENT });
        objectId = result?.objectId;
        if (!objectId) return undefined;
        const { node } = await debug.sendCommand("DOM.describeNode", { objectId });
        backendNodeId = node.backendNodeId;
      }
      if (!objectId || typeof backendNodeId !== "number") return undefined;
      const { result } = await debug.sendCommand("Runtime.callFunctionOn", {
        objectId, functionDeclaration: READ_SELECT, returnByValue: true,
      });
      const picker = result?.value as Omit<BrowserSelectPicker, "id"> | null;
      if (!picker || !Array.isArray(picker.options) || !picker.options.length) return undefined;
      const rect = picker.rect;
      return { backendNodeId, picker: { ...picker,
        rect: { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom },
      } };
    } finally {
      if (objectId) await debug.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }
}
