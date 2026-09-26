import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { BrowserPageEvent, BrowserSelectPicker, BrowserValuePicker } from "../shared/desktop-api";

/**
 * 网页的原生选择器：下拉框的列表、日期/时间/颜色框的选择器。离屏页面里它们是浏览器另开的
 * 弹层，画不出来，所以只截住用户打开它们的那一下，交给面板：
 *
 * - 单选下拉框：面板自己画出选项列表（PageSelectPicker），选完写回。列表式、多选的下拉框
 *   本来就画在页面里，照常。
 * - 日期、时间、日期时间、月份、周、颜色：面板在输入框的位置放一个同类型的隐形输入框，打开
 *   App 窗口里 Chromium 自己的选择器（PageValuePicker）——和 Chrome 里一模一样，不是仿的；
 *   选的值写回页面，并照常发 input/change。日期类只有点在右边小日历图标上才打开（和 Chrome
 *   一样，点在年月日上是改那一格）；网页把图标藏起来了就不打开。颜色框点哪儿都打开。
 *
 * AI 的 fill/select 工具照常工作，不经过这里。命中检查只读，不在超时、切页后悄悄改变网页焦点。
 * 小日历图标在浏览器自己的内部结构里：只用节点描述量它的位置，不在它上面跑页面脚本。
 *
 * 已知不支持：跨站 iframe 里的这些控件。它在另一个渲染进程里，主页面看不到它的内容，
 * 点击照常送进去（和现在一样没有弹层）。网页脚本自己调 showPicker() 打开的也接不到。
 */

/** 日期、时间、颜色这类由浏览器弹选择器的输入框。 */
const VALUE_TYPES = ["date", "time", "datetime-local", "month", "week", "color"] as const;
/** 其中带小日历图标、点图标才打开的那些（颜色框点哪儿都打开）。 */
const CALENDAR_TYPES = new Set<string>(VALUE_TYPES.filter((type) => type !== "color"));

/** 从命中的节点找到它所在的下拉框；不是可弹出的单选下拉框返回 null。 */
const SELECT_OF = `(node) => {
  const element = node && node.nodeType === 1 ? node : node && node.parentElement;
  const select = element && element.closest ? element.closest("select") : null;
  return select && select.isConnected && !select.multiple && !(select.size > 1) && !select.disabled ? select : null;
}`;
/** 从命中的节点找到它所在的日期、时间、颜色输入框；禁用、只读的不算。 */
const VALUE_INPUT_OF = `(node) => {
  const element = node && node.nodeType === 1 ? node : node && node.parentElement;
  const input = element && element.tagName === "INPUT" ? element : null;
  return input && input.isConnected && ${JSON.stringify(VALUE_TYPES)}.includes(input.type) && !input.disabled && !input.readOnly ? input : null;
}`;
/** 选项的样子。读和写用同一份，写回前拿它核对页面是不是还是那张列表；长度有上限，异常页面撑不爆消息。 */
const OPTIONS = `(select) => [...select.options].slice(0, 2000).map((option) => ({
  label: String(option.label || option.text).slice(0, 500),
  value: String(option.value).slice(0, 2000),
  disabled: option.disabled || Boolean(option.parentElement && option.parentElement.disabled),
  group: option.parentElement && option.parentElement.tagName === "OPTGROUP" ? String(option.parentElement.label).slice(0, 500) : "",
}))`;
/** 控件在整页上的位置：内嵌页面要加上每层 frame 的偏移；上层跨源、拿不到 frameElement 时算不出（positioned 为 false）。 */
const PAGE_RECT = `(element) => {
  const rect = element.getBoundingClientRect();
  let x = rect.x, y = rect.y, positioned = true;
  let view = element.ownerDocument.defaultView;
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
  return { rect: { x, y, width: rect.width, height: rect.height }, positioned };
}`;
const READ_TARGET = `function () {
  const select = (${SELECT_OF})(this);
  if (select) return { kind: "select", ...(${PAGE_RECT})(select), selectedIndex: select.selectedIndex, options: (${OPTIONS})(select) };
  const input = (${VALUE_INPUT_OF})(this);
  if (!input) return null;
  const text = (value) => String(value || "").slice(0, 64);
  return { kind: "value", ...(${PAGE_RECT})(input), type: input.type, value: text(input.value), min: text(input.min), max: text(input.max), step: text(input.step) };
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
/**
 * 选择器里选的值写回输入框：类型变了、禁用了、删掉了就不写。用原生的 value 写法，React 这类
 * 框架才认得出是「用户改的」；值变了发 input，选完（final）再发 change，和浏览器自己一样。
 */
const WRITE_VALUE = `function (type, value, final) {
  const input = (${VALUE_INPUT_OF})(this);
  if (!input || input.type !== type) return false;
  if (input.value !== value) {
    const view = input.ownerDocument.defaultView;
    const native = view && view.HTMLInputElement && Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value");
    if (native && native.set) native.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }
  if (final) input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;
/** 和真的点这些控件一样，焦点给它（只在页面里，碰不到用户在 App 里的焦点）。 */
const FOCUS_TARGET = `function () {
  const target = (${SELECT_OF})(this) || (${VALUE_INPUT_OF})(this);
  if (target) target.focus({ preventScroll: true });
  return Boolean(target);
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

type Rect = { x: number; y: number; width: number; height: number };
type SelectData = Omit<BrowserSelectPicker, "id">;
type ValueData = Omit<BrowserValuePicker, "id">;
type Found =
  | { kind: "select"; backendNodeId: number; picker: SelectData }
  | { kind: "value"; backendNodeId: number; picker: ValueData };
type OpenPicker = Found & { id: string; contents: WebContents };
type ReadResult =
  | ({ kind: "select"; positioned: boolean } & SelectData)
  | ({ kind: "value"; positioned: boolean } & ValueData);
/** 打开它的是哪个键：Space、Enter、Alt+↓。 */
type OpeningKey = { key: string; alt: boolean };
type DomNode = { backendNodeId?: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

/** 浏览器内部结构里带某个 pseudo 标记的节点（日期框的小日历图标是 -webkit-calendar-picker-indicator）。 */
function findPseudo(node: DomNode | undefined, pseudo: string, depth = 0): DomNode | undefined {
  if (!node || depth > 12) return undefined;
  const attributes = node.attributes ?? [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === "pseudo" && attributes[index + 1] === pseudo) return node;
  }
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const found = findPseudo(child, pseudo, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export class PageSelects {
  private readonly open = new Map<string, OpenPicker>();
  private readonly requests = new Map<string, object>();
  private readonly watched = new WeakSet<WebContents>();

  constructor(
    private readonly publish: (event: BrowserPageEvent) => void,
    private readonly isCurrent: (tabId: string, contents: WebContents) => boolean = () => true,
    private readonly budgetMs = 150,
  ) {}

  /**
   * point 缺省表示键盘打开当前有焦点的控件（key 是哪个键）。返回 true 表示这一下由面板接走，
   * 不送进页面。
   */
  async intercept(tabId: string, contents: WebContents, point?: { x: number; y: number }, key?: OpeningKey): Promise<boolean> {
    this.watch(tabId, contents);
    this.forget(tabId);
    const request = {};
    this.requests.set(tabId, request);
    const live = (): boolean => this.requests.get(tabId) === request && this.isCurrent(tabId, contents);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([
        this.read(contents, point, key),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), this.budgetMs); }),
      ]);
      if (!live()) return true;
      if (!found || contents.isDestroyed()) return false;
      // 只有仍有效的用户操作才改变焦点；过期命中结果不会补弹列表或偷焦点。
      if (!await this.callOnNode(contents, found.backendNodeId, FOCUS_TARGET)) return false;
      if (!live()) return true;
      const id = randomUUID();
      this.open.set(tabId, { id, contents, ...found });
      if (found.kind === "select") this.publish({ tabId, kind: "select", picker: { id, ...found.picker } });
      else this.publish({ tabId, kind: "value-picker", picker: { id, ...found.picker } });
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
    if (!open || open.id !== pickerId || open.kind !== "select") return;
    this.forget(tabId);
    if (index === null || !Number.isInteger(index) || index < 0 || index >= open.picker.options.length
      || open.contents.isDestroyed() || !this.isCurrent(tabId, open.contents)) return;
    // 选择过程中页面跳走、元素删除：放弃旧选择，不能写进另一张页面。
    await this.callOnNode(open.contents, open.backendNodeId, WRITE_SELECT, [index, open.picker.options]).catch(() => undefined);
  }

  /**
   * 面板的原生选择器里选了值：写回页面。颜色框拖着选时一路都是中间值（final 为 false），
   * 选完那一下 final；value 为 null 是没选就关了。关掉以后再来的值不收。
   */
  async chooseValue(tabId: string, pickerId: string, value: string | null, final: boolean): Promise<void> {
    const open = this.open.get(tabId);
    if (!open || open.id !== pickerId || open.kind !== "value") return;
    if (value === null || final) this.forget(tabId);
    if (value === null || value.length > 64 || open.contents.isDestroyed() || !this.isCurrent(tabId, open.contents)) return;
    await this.callOnNode(open.contents, open.backendNodeId, WRITE_VALUE, [open.picker.type, value, final]).catch(() => undefined);
  }

  forget(tabId: string): void {
    this.requests.delete(tabId);
    const open = this.open.get(tabId);
    if (!open) return;
    this.open.delete(tabId);
    this.publish(open.kind === "select" ? { tabId, kind: "select", picker: null } : { tabId, kind: "value-picker", picker: null });
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

  private async read(contents: WebContents, point?: { x: number; y: number }, key?: OpeningKey): Promise<Found | undefined> {
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return undefined;
    const debug = contents.debugger;
    // 送进页面的坐标是页面窗口的像素；页面放大缩小过的话，网页里的坐标要除以缩放倍数。
    const zoom = contents.getZoomFactor() || 1;
    const at = point ? { x: point.x / zoom, y: point.y / zoom } : undefined;
    let backendNodeId: number | undefined;
    if (at) {
      const hit = await debug.sendCommand("DOM.getNodeForLocation", {
        x: Math.round(at.x), y: Math.round(at.y), includeUserAgentShadowDOM: false,
      });
      backendNodeId = hit.backendNodeId;
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
    const found = await this.callOnNode(contents, backendNodeId, READ_TARGET) as ReadResult | null | undefined;
    if (!found) return undefined;
    if (found.kind === "select") {
      if (!Array.isArray(found.options) || found.options.length === 0) return undefined;
      if (key && !(key.key === " " || key.key === "Enter" || (key.key === "ArrowDown" && key.alt))) return undefined;
      const { kind: _kind, positioned, ...picker } = found;
      return { kind: "select", backendNodeId, picker: { ...picker, rect: this.windowRect(picker.rect, positioned, at, zoom) } };
    }
    if (!(VALUE_TYPES as readonly string[]).includes(found.type)) return undefined;
    const calendar = CALENDAR_TYPES.has(found.type);
    // 键盘：颜色框按空格、回车打开；日期类按 Alt+↓（和 Chrome 一样，空格、回车是改年月日那一格）。
    if (key && !(calendar ? key.key === "ArrowDown" && key.alt : key.key === " " || key.key === "Enter")) return undefined;
    // 鼠标：日期类只有点在小日历图标上才打开。
    if (at && calendar && !(found.positioned && await this.onCalendarIcon(contents, backendNodeId, at, found.rect))) return undefined;
    const { kind: _kind, positioned, ...picker } = found;
    return { kind: "value", backendNodeId, picker: { ...picker, rect: this.windowRect(picker.rect, positioned, at, zoom) } };
  }

  /** 控件在页面窗口里的位置。算不出（上层是跨源内嵌页面）时，贴着用户点的地方。 */
  private windowRect(rect: Rect, positioned: boolean, at: { x: number; y: number } | undefined, zoom: number): Rect {
    const placed = positioned || !at ? rect : { ...rect, x: at.x - 8, y: at.y - rect.height / 2 };
    return { x: placed.x * zoom, y: placed.y * zoom, width: placed.width * zoom, height: placed.height * zoom };
  }

  /**
   * 点在日期框右边的小日历图标上吗。图标在浏览器内部结构里：只用节点描述找到它、量它在
   * 输入框里占哪一段（按比例算，和页面缩放无关），不在它上面跑页面脚本。网页把图标藏起来了
   * 量不出位置，就当没点到——和 Chrome 一样不弹。
   */
  private async onCalendarIcon(contents: WebContents, backendNodeId: number, at: { x: number; y: number }, rect: Rect): Promise<boolean> {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const debug = contents.debugger;
    const { node } = await debug.sendCommand("DOM.describeNode", { backendNodeId, depth: -1, pierce: true }) as { node?: DomNode };
    const icon = findPseudo(node, "-webkit-calendar-picker-indicator");
    if (typeof icon?.backendNodeId !== "number") return false;
    let host: number[];
    let box: number[];
    try {
      host = (await debug.sendCommand("DOM.getBoxModel", { backendNodeId })).model.border;
      box = (await debug.sendCommand("DOM.getBoxModel", { backendNodeId: icon.backendNodeId })).model.border;
    } catch {
      return false;
    }
    const width = host[2] - host[0];
    const height = host[5] - host[1];
    if (!(width > 0 && height > 0)) return false;
    const fx = (at.x - rect.x) / rect.width;
    const fy = (at.y - rect.y) / rect.height;
    const slackX = 2 / rect.width;
    const slackY = 2 / rect.height;
    return fx >= (box[0] - host[0]) / width - slackX && fx <= (box[2] - host[0]) / width + slackX
      && fy >= (box[1] - host[1]) / height - slackY && fy <= (box[5] - host[1]) / height + slackY;
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
