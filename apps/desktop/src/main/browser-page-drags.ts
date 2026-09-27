import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { WebContents } from "electron";
import type { BrowserInputModifiers } from "../shared/desktop-api";

/**
 * 离屏页面里的拖放。
 *
 * 1. 页面里自己的拖拽（能拖的树节点、能排序的列表、把选中的字拖进输入框）：离屏页面里
 *    浏览器的拖拽开了头就卡住——有「开始拖」，没有「经过」「放下」，也不结束。所以在
 *    调试通道上打开「拖拽拦截」：页面开始拖时浏览器把拖的内容交过来，之后按着键的那一方
 *    （用户或 Agent）的鼠标移动、松手，换成拖拽的「经过」「放下」送回页面；用户按 Esc
 *    取消。网页收到的和在 Chrome 里拖一样。
 * 2. 从外面拖文件进页面（访达里拖到上传区、拖到选文件框）：面板在松手时拿到文件的路径，
 *    按「进入 → 经过 → 放下」送进页面，网页能读到文件内容。拖到不收文件的地方什么都
 *    不发生（不会像 Chrome 那样把整个页面换成这个文件）。
 *
 * 拖拽拦截是页面上的开关，和 Agent 共用一条调试通道：Agent 自己要接管拖拽时（旧版
 * Puppeteer 的 setDragInterception）不去动这个开关，只把它自己的拖拽交给它办。
 */

/** CDP 的 Input.DragData。 */
export interface DragData {
  items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }>;
  files?: string[];
  dragOperationsMask: number;
}

type Who = "user" | "agent";
type Point = { x: number; y: number };
type DragType = "dragEnter" | "dragOver" | "drop" | "dragCancel";

interface PageState {
  /** 正在拖的：拖的内容、谁在拖、有没有进过页面、最后一次动静。 */
  active?: { data: DragData; by: Who; entered: boolean; at: number };
  /** 谁的左键正按着。 */
  pressed: Record<Who, boolean>;
  /** 最后一个按着键移动鼠标的：页面开始拖的时候，拖的就是他。 */
  lastMover?: Who;
  /** 各自最后一次鼠标的位置：手快的，页面开始拖时已经松手，就在这里放下。 */
  lastPoint: Partial<Record<Who, Point>>;
  /** Agent 说它自己接拖拽。 */
  agentIntercepts: boolean;
}

/** 拖进来的文件：复制、链接、移动都允许，网页挑它要的（和从访达拖出来一样）。 */
const ANY_OPERATION = 1 | 2 | 16;
/** 拖了这么久没有动静（比如拖到一半切走了），下次按下时先取消它。 */
const STALE_MS = 30_000;
/** 一次最多放进这么多个文件，多的不要。 */
const MAX_FILES = 100;

/** 面板鼠标事件里的修饰键，换成 CDP 的位：Alt 1、Ctrl 2、Meta 4、Shift 8。 */
export function modifierBits(modifiers: BrowserInputModifiers): number {
  return (modifiers.alt ? 1 : 0) | (modifiers.control ? 2 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0);
}

/** 页面交来的拖拽内容逐项核对。 */
export function parseDragData(value: unknown): DragData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.items) || typeof raw.dragOperationsMask !== "number") return undefined;
  const items = raw.items.filter((item): item is DragData["items"][number] => {
    const entry = item as Record<string, unknown> | null;
    return !!entry && typeof entry === "object" && typeof entry.mimeType === "string" && typeof entry.data === "string";
  });
  const files = Array.isArray(raw.files) ? raw.files.filter((file): file is string => typeof file === "string") : [];
  return { items, ...(files.length ? { files } : {}), dragOperationsMask: raw.dragOperationsMask };
}

/**
 * 面板送来的「在哪儿松手、拖进来哪些文件」逐项核对：路径只收磁盘上真有的绝对路径（预加载
 * 只从真拖进来的文件上取路径，这里再核一遍）；位置贴进页面里。
 */
export function parseFileDrop(point: unknown, paths: unknown, pageSize: { width: number; height: number }):
  { point: Point; modifiers: BrowserInputModifiers; files: string[] } | undefined {
  if (!point || typeof point !== "object" || !Array.isArray(paths)) return undefined;
  const raw = point as Record<string, unknown>;
  if (typeof raw.x !== "number" || typeof raw.y !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined;
  const mods = raw.modifiers && typeof raw.modifiers === "object" ? raw.modifiers as Record<string, unknown> : {};
  const files = paths.slice(0, MAX_FILES).filter((path): path is string => {
    if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path)) return false;
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  });
  if (!files.length) return undefined;
  return {
    point: {
      x: Math.max(0, Math.min(pageSize.width - 1, raw.x)),
      y: Math.max(0, Math.min(pageSize.height - 1, raw.y)),
    },
    modifiers: { shift: mods.shift === true, control: mods.control === true, alt: mods.alt === true, meta: mods.meta === true },
    files,
  };
}

export class PageDrags {
  private readonly pages = new WeakMap<WebContents, PageState>();

  /** 调试器挂上之后调一次：听「页面开始拖了」、打开拖拽拦截；换页时丢掉没拖完的。失败不抛。 */
  async install(contents: WebContents): Promise<void> {
    const debug = contents.debugger;
    debug.on("message", (_event, method: string, params: Record<string, unknown> | undefined) => {
      if (method === "Input.dragIntercepted") this.started(contents, params?.data);
    });
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.state(contents).active = undefined;
    });
    try {
      if (debug.isAttached()) await debug.sendCommand("Input.setInterceptDrags", { enabled: true });
    } catch (error) {
      console.warn("[browser] 打开拖拽拦截失败", error instanceof Error ? error.message : error);
    }
  }

  /**
   * 用户的一次鼠标事件（面板送来的，已经是页面坐标）。用户正拖着页面里的东西时，换成拖拽的
   * 「经过」「放下」：返回 true 表示已经送过了，不要再当鼠标事件送。
   */
  async userMouse(contents: WebContents, event: {
    type: string; x: number; y: number; button: string; buttons: number; modifiers: BrowserInputModifiers;
  }): Promise<boolean> {
    const state = this.state(contents);
    const point = { x: event.x, y: event.y };
    const bits = modifierBits(event.modifiers);
    const left = event.button === "left";
    if (event.type === "down" && left) {
      // 上一次拖到一半松手丢了（比如按着键切走了标签页）：先把它取消，这次按下照常。
      if (state.active && (state.active.by === "user" || Date.now() - state.active.at > STALE_MS)) await this.finish(contents, state, undefined, bits);
      state.pressed.user = true;
    }
    if (event.type === "move" && event.buttons & 1) state.lastMover = "user";
    if (event.type !== "leave") state.lastPoint.user = point;
    const releasing = event.type === "up" && left;
    if (releasing) state.pressed.user = false;
    const drag = state.active;
    if (!drag || drag.by !== "user") return false;
    if (event.type === "move") {
      await this.over(contents, drag, point, bits);
      return true;
    }
    if (releasing) {
      await this.finish(contents, state, point, bits);
      return true;
    }
    // 拖着的时候按别的键：不送，和系统的拖拽一样。
    return event.type === "down" || event.type === "up";
  }

  /** 用户按了 Esc：他正拖着的话取消这次拖拽，返回 true（这次按键不再送进页面）。 */
  async userEscape(contents: WebContents): Promise<boolean> {
    const state = this.pages.get(contents);
    if (state?.active?.by !== "user") return false;
    await this.finish(contents, state, undefined, 0);
    return true;
  }

  /**
   * Agent 的一次鼠标事件（CDP Input.dispatchMouseEvent，转给页面之前先过这里）。Agent 正拖着
   * 页面里的东西、又没说要自己接时，换成拖拽送进去：返回 true 表示不要再转给页面。
   */
  async agentMouse(contents: WebContents, params: Record<string, unknown>): Promise<boolean> {
    const x = params.x;
    const y = params.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const state = this.state(contents);
    const point = { x, y };
    const bits = typeof params.modifiers === "number" ? params.modifiers : 0;
    const left = params.button === "left";
    if (params.type === "mousePressed" && left) {
      if (state.active && (state.active.by === "agent" || Date.now() - state.active.at > STALE_MS)) await this.finish(contents, state, undefined, bits);
      state.pressed.agent = true;
    }
    const holding = typeof params.buttons === "number" ? (params.buttons & 1) !== 0 : state.pressed.agent;
    if (params.type === "mouseMoved" && holding) state.lastMover = "agent";
    if (params.type !== "mouseWheel") state.lastPoint.agent = point;
    const releasing = params.type === "mouseReleased" && left;
    if (releasing) state.pressed.agent = false;
    const drag = state.active;
    if (!drag || drag.by !== "agent") return false;
    if (params.type === "mouseMoved") {
      await this.over(contents, drag, point, bits);
      return true;
    }
    if (releasing) {
      await this.finish(contents, state, point, bits);
      return true;
    }
    return params.type === "mousePressed" || params.type === "mouseReleased";
  }

  /** Agent 按了 Esc（CDP 按键）：它正拖着东西的话取消这次拖拽，返回 true（这一下不再送进页面）。 */
  async agentKey(contents: WebContents, params: Record<string, unknown>): Promise<boolean> {
    const escape = (params.type === "keyDown" || params.type === "rawKeyDown")
      && (params.key === "Escape" || params.code === "Escape" || params.windowsVirtualKeyCode === 27);
    const state = this.pages.get(contents);
    if (!escape || state?.active?.by !== "agent") return false;
    await this.finish(contents, state, undefined, 0);
    return true;
  }

  /** Agent 要自己接拖拽（或者不要了）：拦截开关一直开着，只记下来。 */
  setAgentIntercepts(contents: WebContents, enabled: boolean): void {
    this.state(contents).agentIntercepts = enabled;
  }

  /** 页面交来的这次拖拽要不要转给 Agent：它说了自己接，而且是它拖的。 */
  relayToAgent(contents: WebContents): boolean {
    const state = this.pages.get(contents);
    return state?.agentIntercepts === true && state.lastMover === "agent";
  }

  /** 用户从外面拖进来的文件，放进页面上松手的位置。 */
  async dropFiles(contents: WebContents, point: Point, files: string[], modifiers: BrowserInputModifiers): Promise<void> {
    const data: DragData = { items: [], files, dragOperationsMask: ANY_OPERATION };
    const bits = modifierBits(modifiers);
    for (const type of ["dragEnter", "dragOver", "drop"] as const) await this.dispatch(contents, type, point, data, bits);
  }

  /** 页面开始拖了：记下拖的内容和是谁拖的。 */
  private started(contents: WebContents, raw: unknown): void {
    const data = parseDragData(raw);
    if (!data) return;
    const state = this.state(contents);
    const by = state.lastMover ?? "agent";
    // Agent 自己接的，交给它（事件由桥转过去）。
    if (by === "agent" && state.agentIntercepts) return;
    state.active = { data, by, entered: false, at: Date.now() };
    // 手快的：页面开始拖的时候键已经松开了，就在松手的地方放下。
    if (!state.pressed[by]) {
      void this.finish(contents, state, state.lastPoint[by], 0).catch((error: unknown) => {
        console.warn("[browser] 放下拖拽失败", error instanceof Error ? error.message : error);
      });
    }
  }

  private async over(contents: WebContents, drag: NonNullable<PageState["active"]>, point: Point, bits: number): Promise<void> {
    drag.at = Date.now();
    if (!drag.entered) {
      drag.entered = true;
      await this.dispatch(contents, "dragEnter", point, drag.data, bits);
    }
    await this.dispatch(contents, "dragOver", point, drag.data, bits);
  }

  /** 拖完：在 point 放下；没有 point 就是取消。 */
  private async finish(contents: WebContents, state: PageState, point: Point | undefined, bits: number): Promise<void> {
    const drag = state.active;
    if (!drag) return;
    state.active = undefined;
    if (!point) {
      await this.dispatch(contents, "dragCancel", state.lastPoint[drag.by] ?? { x: 0, y: 0 }, drag.data, bits);
      return;
    }
    if (!drag.entered) await this.dispatch(contents, "dragEnter", point, drag.data, bits);
    await this.dispatch(contents, "dragOver", point, drag.data, bits);
    await this.dispatch(contents, "drop", point, drag.data, bits);
  }

  private async dispatch(contents: WebContents, type: DragType, point: Point, data: DragData, modifiers: number): Promise<void> {
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
    await contents.debugger.sendCommand("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data, modifiers });
  }

  private state(contents: WebContents): PageState {
    let state = this.pages.get(contents);
    if (!state) {
      state = { pressed: { user: false, agent: false }, lastPoint: {}, agentIntercepts: false };
      this.pages.set(contents, state);
    }
    return state;
  }
}
