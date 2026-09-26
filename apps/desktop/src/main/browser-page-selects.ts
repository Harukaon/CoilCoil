import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { BrowserPageEvent, BrowserSelectPicker } from "../shared/desktop-api";

/**
 * 离屏页面里的原生下拉弹层在 Mac 上无法显示。只截住用户打开单选下拉框的动作，
 * 让面板画出选项；列表式、多选仍由网页自己处理。AI 的 fill/select 工具照常工作。
 * 命中检查只读，不在超时、切页后悄悄改变网页焦点。
 *
 * 已知不支持：跨站 iframe 里的下拉框。它在另一个渲染进程里，主页面看不到它的内容，
 * 点击照常送进去（和现在一样没有弹层），留到后续细节阶段处理。
 */

/** 从命中的节点找到它所在的下拉框；不是可弹出的单选下拉框返回 null。 */
const SELECT_OF = `(node) => {
  const element = node && node.nodeType === 1 ? node : node && node.parentElement;
  const select = element && element.closest ? element.closest("select") : null;
  return select && select.isConnected && !select.multiple && !(select.size > 1) && !select.disabled ? select : null;
}`;
/** 选项的样子。读和写用同一份，写回前拿它核对页面是不是还是那张列表；长度有上限，异常页面撑不爆消息。 */
const OPTIONS = `(select) => [...select.options].slice(0, 2000).map((option) => ({
  label: String(option.label || option.text).slice(0, 500),
  value: String(option.value).slice(0, 2000),
  disabled: option.disabled || Boolean(option.parentElement && option.parentElement.disabled),
  group: option.parentElement && option.parentElement.tagName === "OPTGROUP" ? String(option.parentElement.label).slice(0, 500) : "",
}))`;
const READ_SELECT = `function () {
  const select = (${SELECT_OF})(this);
  if (!select) return null;
  const rect = select.getBoundingClientRect();
  let x = rect.x, y = rect.y, positioned = true;
  // 内嵌页面的坐标要加上每层 frame 的偏移；上层跨源、拿不到 frameElement 时算不出，交给调用方按点击位置摆。
  let view = select.ownerDocument.defaultView;
  while (view && view !== view.parent) {
    let frame = null;
    try { frame = view.frameElement; } catch {}
    if (!frame) { positioned = false; break; }
    const box = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView.getComputedStyle(frame);
    x += box.x + frame.clientLeft + (parseFloat(style.paddingLeft) || 0);
    y += box.y + frame.clientTop + (parseFloat(style.paddingTop) || 0);
    view = frame.ownerDocument.defaultView;
  }
  return { rect: { x, y, width: rect.width, height: rect.height }, positioned,
    selectedIndex: select.selectedIndex, options: (${OPTIONS})(select) };
}`;
const WRITE_SELECT = `function (index, expected) {
  const select = (${SELECT_OF})(this);
  if (!select) return false;
  // 页面可能已被用户或 AI 改过。旧列表里的「第 2 项」不能写成新列表里的另一项。
  const options = (${OPTIONS})(select);
  const same = options.length === expected.length && options.every((option, i) =>
    option.label === expected[i].label && option.value === expected[i].value
    && option.disabled === expected[i].disabled && option.group === expected[i].group);
  if (!same || !options[index] || options[index].disabled) return false;
  if (select.selectedIndex === index) return true;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;
/** 和真的点下拉框一样，焦点给它（只在页面里，碰不到用户在 App 里的焦点）。 */
const FOCUS_SELECT = `function () {
  const select = (${SELECT_OF})(this);
  if (select) select.focus({ preventScroll: true });
  return Boolean(select);
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

type PickerData = Omit<BrowserSelectPicker, "id">;

interface OpenSelect {
  id: string;
  backendNodeId: number;
  contents: WebContents;
  picker: PickerData;
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

  /** point 缺省表示键盘打开当前有焦点的下拉框。返回 true 表示这一下由面板接走，不送进页面。 */
  async intercept(tabId: string, contents: WebContents, point?: { x: number; y: number }): Promise<boolean> {
    this.watch(tabId, contents);
    this.forget(tabId);
    const request = {};
    this.requests.set(tabId, request);
    const live = (): boolean => this.requests.get(tabId) === request && this.isCurrent(tabId, contents);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([
        this.read(contents, point),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), this.budgetMs); }),
      ]);
      if (!live()) return true;
      if (!found || contents.isDestroyed()) return false;
      // 只有仍有效的用户操作才改变焦点；过期命中结果不会补弹列表或偷焦点。
      if (!await this.callOnNode(contents, found.backendNodeId, FOCUS_SELECT)) return false;
      if (!live()) return true;
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
    // 选择过程中页面跳走、元素删除：放弃旧选择，不能写进另一张页面。
    await this.callOnNode(open.contents, open.backendNodeId, WRITE_SELECT, [index, open.picker.options]).catch(() => undefined);
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
    // 送进页面的坐标是页面窗口的像素；页面放大缩小过的话，网页里的坐标要除以缩放倍数。
    const zoom = contents.getZoomFactor() || 1;
    let backendNodeId: number | undefined;
    if (point) {
      const at = await debug.sendCommand("DOM.getNodeForLocation", {
        x: Math.round(point.x / zoom), y: Math.round(point.y / zoom), includeUserAgentShadowDOM: false,
      });
      backendNodeId = at.backendNodeId;
    } else {
      const { result } = await debug.sendCommand("Runtime.evaluate", { expression: FOCUSED_ELEMENT });
      if (!result?.objectId) return undefined;
      try {
        const { node } = await debug.sendCommand("DOM.describeNode", { objectId: result.objectId });
        backendNodeId = node?.backendNodeId;
      } finally {
        await debug.sendCommand("Runtime.releaseObject", { objectId: result.objectId }).catch(() => undefined);
      }
    }
    if (typeof backendNodeId !== "number") return undefined;
    const found = await this.callOnNode(contents, backendNodeId, READ_SELECT) as (PickerData & { positioned: boolean }) | null | undefined;
    if (!found || !Array.isArray(found.options) || found.options.length === 0) return undefined;
    const { positioned, ...picker } = found;
    // 算不出下拉框在整页上的位置时（上层是跨源内嵌页面），贴着用户点的地方弹出。
    const rect = positioned || !point
      ? picker.rect
      : { ...picker.rect, x: point.x / zoom - 8, y: point.y / zoom - picker.rect.height / 2 };
    return {
      backendNodeId,
      picker: { ...picker, rect: { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom } },
    };
  }

  /** 在这个节点上跑一段页面脚本，拿回结果；节点已经不在了返回 undefined。临时引用用完即还。 */
  private async callOnNode(contents: WebContents, backendNodeId: number, functionDeclaration: string, args: unknown[] = []): Promise<unknown> {
    const debug = contents.debugger;
    const { object } = await debug.sendCommand("DOM.resolveNode", { backendNodeId });
    const objectId: string | undefined = object?.objectId;
    if (!objectId) return undefined;
    try {
      const { result } = await debug.sendCommand("Runtime.callFunctionOn", {
        objectId, functionDeclaration, returnByValue: true, arguments: args.map((value) => ({ value })),
      });
      return result?.value;
    } finally {
      await debug.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }
}
