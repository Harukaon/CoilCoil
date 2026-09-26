import type { InputEvent, MouseInputEvent, MouseWheelInputEvent, NativeImage, WebContents } from "electron";
import type { BrowserFindRequest, BrowserInputModifiers, BrowserPageInput } from "../shared/desktop-api";

/**
 * 把用户在面板里对网页的操作，原样送进那张离屏页面。
 *
 * 页面是离屏渲染的（见 browser-offscreen.ts），面板里显示的只是它的画面，所以用户的
 * 鼠标、键盘、输入法都要由我们转进去。走的都是 Chromium 的真实输入通道，网页看到的
 * 和用户直接在浏览器里操作一样：
 *
 * - 鼠标、滚轮：`webContents.sendInputEvent`，和真的鼠标走同一条路（点中、悬停、拖选、
 *   双击选词、右键都和原生一样）。
 * - 键盘：CDP `Input.dispatchKeyEvent`。它能带上「这个键在 Mac 上对应的编辑命令」
 *   （⌥← 按词移动、⌘A 全选……），`sendInputEvent` 带不了，在 Mac 上这些键会没反应。
 * - 输入法：用户在面板自己的输入框里组字，组字过程和结果用 CDP
 *   `Input.imeSetComposition` / `Input.insertText` 送进去，网页收到完整的
 *   compositionstart/update/end。
 *
 * 这里只管「怎么送」，不管「该不该送」：只接受当前会话正显示着的那张页面，由
 * BrowserRuntimeManager 在调用前核对。
 */

/** CDP 的修饰键位：Alt=1 Ctrl=2 Meta=4 Shift=8。 */
export function cdpModifiers(modifiers: BrowserInputModifiers): number {
  return (modifiers.alt ? 1 : 0) | (modifiers.control ? 2 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0);
}

type ElectronModifier = NonNullable<InputEvent["modifiers"]>[number];

/** `sendInputEvent` 的修饰键；拖动时还要说明哪个键一直按着，不然页面当成鼠标已经松开，拖选不出来。 */
export function electronModifiers(modifiers: BrowserInputModifiers, buttons = 0): ElectronModifier[] {
  const list: ElectronModifier[] = [];
  if (modifiers.shift) list.push("shift");
  if (modifiers.control) list.push("control");
  if (modifiers.alt) list.push("alt");
  if (modifiers.meta) list.push("meta");
  if (buttons & 1) list.push("leftbuttondown");
  if (buttons & 2) list.push("rightbuttondown");
  if (buttons & 4) list.push("middlebuttondown");
  return list;
}

const MOUSE_TYPES = { down: "mouseDown", up: "mouseUp", move: "mouseMove", enter: "mouseEnter", leave: "mouseLeave" } as const;

export function mouseInputEvent(input: Extract<BrowserPageInput, { kind: "mouse" }>): MouseInputEvent {
  return {
    type: MOUSE_TYPES[input.type],
    x: Math.round(input.x),
    y: Math.round(input.y),
    ...input.button === "none" ? {} : { button: input.button },
    clickCount: input.clickCount,
    modifiers: electronModifiers(input.modifiers, input.buttons),
  };
}

/**
 * 滚轮。方向和网页里的 WheelEvent 相反：DOM 里 deltaY 为正是往下滚，Chromium 这边
 * 为正是往上滚（实测：deltaY -600 页面往下走）。触控板给的是像素级的连续量。
 */
export function wheelInputEvent(input: Extract<BrowserPageInput, { kind: "wheel" }>): MouseWheelInputEvent {
  return {
    type: "mouseWheel",
    x: Math.round(input.x),
    y: Math.round(input.y),
    deltaX: -input.deltaX,
    deltaY: -input.deltaY,
    hasPreciseScrollingDeltas: true,
    canScroll: true,
    modifiers: electronModifiers(input.modifiers),
  };
}

/**
 * Mac 上这些按键组合在输入框里是「编辑命令」，不是字符：网页收到按键之外，还要让
 * Chromium 执行对应的命令，⌥← 才会按词移动、⌘⌫ 才会删到行首。表和 Playwright 的
 * macEditingCommands 一致（取自 macOS 的标准按键绑定；Playwright 为 Apache-2.0 许可）。
 * 插入类命令（insertNewline 等）不带：那由按键本身的字符完成。
 */
const MAC_EDITING_COMMANDS: Record<string, string | string[]> = {
  Backspace: "deleteBackward:",
  Enter: "insertNewline:",
  NumpadEnter: "insertNewline:",
  Escape: "cancelOperation:",
  ArrowUp: "moveUp:",
  ArrowDown: "moveDown:",
  ArrowLeft: "moveLeft:",
  ArrowRight: "moveRight:",
  F5: "complete:",
  Delete: "deleteForward:",
  Home: "scrollToBeginningOfDocument:",
  End: "scrollToEndOfDocument:",
  PageUp: "scrollPageUp:",
  PageDown: "scrollPageDown:",
  "Shift+Backspace": "deleteBackward:",
  "Shift+Enter": "insertNewline:",
  "Shift+NumpadEnter": "insertNewline:",
  "Shift+Escape": "cancelOperation:",
  "Shift+ArrowUp": "moveUpAndModifySelection:",
  "Shift+ArrowDown": "moveDownAndModifySelection:",
  "Shift+ArrowLeft": "moveLeftAndModifySelection:",
  "Shift+ArrowRight": "moveRightAndModifySelection:",
  "Shift+F5": "complete:",
  "Shift+Delete": "deleteForward:",
  "Shift+Home": "moveToBeginningOfDocumentAndModifySelection:",
  "Shift+End": "moveToEndOfDocumentAndModifySelection:",
  "Shift+PageUp": "pageUpAndModifySelection:",
  "Shift+PageDown": "pageDownAndModifySelection:",
  "Shift+Numpad5": "delete:",
  "Control+Tab": "selectNextKeyView:",
  "Control+Enter": "insertLineBreak:",
  "Control+NumpadEnter": "insertLineBreak:",
  "Control+Quote": "insertSingleQuoteIgnoringSubstitution:",
  "Control+KeyA": "moveToBeginningOfParagraph:",
  "Control+KeyB": "moveBackward:",
  "Control+KeyD": "deleteForward:",
  "Control+KeyE": "moveToEndOfParagraph:",
  "Control+KeyF": "moveForward:",
  "Control+KeyH": "deleteBackward:",
  "Control+KeyK": "deleteToEndOfParagraph:",
  "Control+KeyL": "centerSelectionInVisibleArea:",
  "Control+KeyN": "moveDown:",
  "Control+KeyO": ["insertNewlineIgnoringFieldEditor:", "moveBackward:"],
  "Control+KeyP": "moveUp:",
  "Control+KeyT": "transpose:",
  "Control+KeyV": "pageDown:",
  "Control+KeyY": "yank:",
  "Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
  "Control+ArrowUp": "scrollPageUp:",
  "Control+ArrowDown": "scrollPageDown:",
  "Control+ArrowLeft": "moveToLeftEndOfLine:",
  "Control+ArrowRight": "moveToRightEndOfLine:",
  "Shift+Control+Enter": "insertLineBreak:",
  "Shift+Control+NumpadEnter": "insertLineBreak:",
  "Shift+Control+Tab": "selectPreviousKeyView:",
  "Shift+Control+Quote": "insertDoubleQuoteIgnoringSubstitution:",
  "Shift+Control+KeyA": "moveToBeginningOfParagraphAndModifySelection:",
  "Shift+Control+KeyB": "moveBackwardAndModifySelection:",
  "Shift+Control+KeyE": "moveToEndOfParagraphAndModifySelection:",
  "Shift+Control+KeyF": "moveForwardAndModifySelection:",
  "Shift+Control+KeyN": "moveDownAndModifySelection:",
  "Shift+Control+KeyP": "moveUpAndModifySelection:",
  "Shift+Control+KeyV": "pageDownAndModifySelection:",
  "Shift+Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
  "Shift+Control+ArrowUp": "scrollPageUp:",
  "Shift+Control+ArrowDown": "scrollPageDown:",
  "Shift+Control+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
  "Shift+Control+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
  "Alt+Backspace": "deleteWordBackward:",
  "Alt+Enter": "insertNewlineIgnoringFieldEditor:",
  "Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
  "Alt+Escape": "complete:",
  "Alt+ArrowUp": ["moveBackward:", "moveToBeginningOfParagraph:"],
  "Alt+ArrowDown": ["moveForward:", "moveToEndOfParagraph:"],
  "Alt+ArrowLeft": "moveWordLeft:",
  "Alt+ArrowRight": "moveWordRight:",
  "Alt+Delete": "deleteWordForward:",
  "Alt+PageUp": "pageUp:",
  "Alt+PageDown": "pageDown:",
  "Shift+Alt+Backspace": "deleteWordBackward:",
  "Shift+Alt+Enter": "insertNewlineIgnoringFieldEditor:",
  "Shift+Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
  "Shift+Alt+Escape": "complete:",
  "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection:",
  "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection:",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection:",
  "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection:",
  "Shift+Alt+Delete": "deleteWordForward:",
  "Shift+Alt+PageUp": "pageUp:",
  "Shift+Alt+PageDown": "pageDown:",
  "Control+Alt+KeyB": "moveWordBackward:",
  "Control+Alt+KeyF": "moveWordForward:",
  "Control+Alt+Backspace": "deleteWordBackward:",
  "Shift+Control+Alt+KeyB": "moveWordBackwardAndModifySelection:",
  "Shift+Control+Alt+KeyF": "moveWordForwardAndModifySelection:",
  "Shift+Control+Alt+Backspace": "deleteWordBackward:",
  "Meta+NumpadSubtract": "cancel:",
  "Meta+Backspace": "deleteToBeginningOfLine:",
  "Meta+ArrowUp": "moveToBeginningOfDocument:",
  "Meta+ArrowDown": "moveToEndOfDocument:",
  "Meta+ArrowLeft": "moveToLeftEndOfLine:",
  "Meta+ArrowRight": "moveToRightEndOfLine:",
  "Shift+Meta+NumpadSubtract": "cancel:",
  "Shift+Meta+Backspace": "deleteToBeginningOfLine:",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection:",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection:",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
  "Meta+KeyA": "selectAll:",
  "Meta+KeyC": "copy:",
  "Meta+KeyX": "cut:",
  "Meta+KeyV": "paste:",
  "Meta+KeyZ": "undo:",
  "Shift+Meta+KeyZ": "redo:",
};

/** 这个键在 Mac 上要附带执行的编辑命令；别的系统上网页内核自己处理（Ctrl+C 这些），不用带。 */
export function macEditingCommands(code: string, modifiers: BrowserInputModifiers): string[] {
  const parts: string[] = [];
  if (modifiers.shift) parts.push("Shift");
  if (modifiers.control) parts.push("Control");
  if (modifiers.alt) parts.push("Alt");
  if (modifiers.meta) parts.push("Meta");
  parts.push(code);
  const found = MAC_EDITING_COMMANDS[parts.join("+")];
  const commands = found === undefined ? [] : typeof found === "string" ? [found] : found;
  return commands.filter((command) => !command.startsWith("insert")).map((command) => command.slice(0, -1));
}

/**
 * 这个键打出来的字；不打字的键（方向键、⌘ 组合）返回 undefined。
 *
 * - 回车打出 "\r"：网页要看到 keypress 和换行，和真的回车一样。
 * - ⌘、Ctrl 组合不打字；但 Ctrl+Alt 一起按是 Windows 上的 AltGr，德语键盘靠它打 @、€，要打字。
 * - Mac 上 ⌥ 组合打的是特殊字符（⌥a 是 å），照打。
 */
export function keyText(input: Extract<BrowserPageInput, { kind: "key" }>): string | undefined {
  if (input.key === "Enter") return "\r";
  if (input.modifiers.meta) return undefined;
  if (input.modifiers.control && !input.modifiers.alt) return undefined;
  // 一个字：key 是单个字符（含表情这种占两个 UTF-16 单元的），不是 "Tab"、"ArrowLeft" 这种键名。
  return [...input.key].length === 1 ? input.key : undefined;
}

export function keyEventParams(
  input: Extract<BrowserPageInput, { kind: "key" }>,
  platform: NodeJS.Platform,
): Record<string, unknown> {
  const modifiers = cdpModifiers(input.modifiers);
  const base = {
    modifiers,
    key: input.key,
    code: input.code,
    windowsVirtualKeyCode: input.keyCode,
    nativeVirtualKeyCode: input.keyCode,
    location: input.location,
    isKeypad: input.location === 3,
  };
  if (input.type === "up") return { type: "keyUp", ...base };
  const text = keyText(input);
  const commands = platform === "darwin" ? macEditingCommands(input.code, input.modifiers) : [];
  return {
    type: text === undefined ? "rawKeyDown" : "keyDown",
    ...base,
    autoRepeat: input.repeat,
    ...text === undefined ? {} : { text, unmodifiedText: text },
    ...commands.length ? { commands } : {},
  };
}

const BUTTONS = new Set(["left", "middle", "right", "none"]);

function isModifiers(value: unknown): value is BrowserInputModifiers {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["shift", "control", "alt", "meta"].every((name) => typeof record[name] === "boolean");
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 界面送来的东西不能直接信：结构不对、数字不对的一律丢掉，别拿去拼输入事件。 */
export function parsePageInput(value: unknown): BrowserPageInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  switch (input.kind) {
    case "mouse":
      if (!(typeof input.type === "string" && Object.hasOwn(MOUSE_TYPES, input.type))) return undefined;
      if (!finite(input.x) || !finite(input.y) || !finite(input.clickCount) || !finite(input.buttons)) return undefined;
      if (typeof input.button !== "string" || !BUTTONS.has(input.button) || !isModifiers(input.modifiers)) return undefined;
      return {
        kind: "mouse",
        type: input.type as keyof typeof MOUSE_TYPES,
        x: input.x,
        y: input.y,
        button: input.button as "left" | "middle" | "right" | "none",
        clickCount: Math.max(0, Math.min(3, Math.round(input.clickCount))),
        buttons: Math.round(input.buttons) & 7,
        modifiers: input.modifiers,
      };
    case "wheel":
      if (!finite(input.x) || !finite(input.y) || !finite(input.deltaX) || !finite(input.deltaY) || !isModifiers(input.modifiers)) return undefined;
      return {
        kind: "wheel",
        x: input.x,
        y: input.y,
        // 一次最多滚几屏，别让一个离谱的数把页面甩到底。
        deltaX: Math.max(-5000, Math.min(5000, input.deltaX)),
        deltaY: Math.max(-5000, Math.min(5000, input.deltaY)),
        modifiers: input.modifiers,
      };
    case "key":
      if (input.type !== "down" && input.type !== "up") return undefined;
      if (typeof input.key !== "string" || input.key.length === 0 || input.key.length > 32) return undefined;
      if (typeof input.code !== "string" || input.code.length > 32 || !finite(input.keyCode) || !finite(input.location)) return undefined;
      if (typeof input.repeat !== "boolean" || !isModifiers(input.modifiers)) return undefined;
      return {
        kind: "key",
        type: input.type,
        key: input.key,
        code: input.code,
        keyCode: Math.round(input.keyCode),
        location: Math.round(input.location),
        repeat: input.repeat,
        modifiers: input.modifiers,
      };
    case "ime":
      if (input.type === "cancel") return { kind: "ime", type: "cancel" };
      if (typeof input.text !== "string" || input.text.length > 10_000) return undefined;
      if (input.type === "commit") return { kind: "ime", type: "commit", text: input.text };
      if (input.type !== "update" || !finite(input.selectionStart) || !finite(input.selectionEnd)) return undefined;
      return { kind: "ime", type: "update", text: input.text, selectionStart: Math.round(input.selectionStart), selectionEnd: Math.round(input.selectionEnd) };
    case "text":
      if (typeof input.text !== "string" || input.text.length === 0 || input.text.length > 10_000) return undefined;
      return { kind: "text", text: input.text };
    case "edit":
      if (!["copy", "cut", "paste", "undo", "redo", "selectAll"].includes(input.command as string)) return undefined;
      return { kind: "edit", command: input.command as "copy" | "cut" | "paste" | "undo" | "redo" | "selectAll" };
    case "focus":
      if (typeof input.focused !== "boolean") return undefined;
      return { kind: "focus", focused: input.focused };
    default:
      return undefined;
  }
}

/** 查找栏送来的请求也逐项核对。 */
export function parseFindRequest(value: unknown): BrowserFindRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Record<string, unknown>;
  if (request.stop === true) return { stop: true };
  if (typeof request.text !== "string" || request.text.length > 1000) return undefined;
  if (typeof request.forward !== "boolean" || typeof request.newSearch !== "boolean") return undefined;
  return { text: request.text, forward: request.forward, newSearch: request.newSearch };
}

/** 坐标只能落在页面里：画面边上拖出去的那一截，贴在边上。 */
export function clampToPage<T extends { x: number; y: number }>(input: T, size: { width: number; height: number }): T {
  return {
    ...input,
    x: Math.max(0, Math.min(size.width - 1, input.x)),
    y: Math.max(0, Math.min(size.height - 1, input.y)),
  };
}

/**
 * 把一次操作送进页面。
 *
 * 所有输入共用一条队列：鼠标按下可能要先检查下拉框，紧跟着的打字和粘贴不能越过
 * 这一步，否则会打进旧输入框。页面切走或导航后，丢弃旧队列里还没发出去的操作。
 */
export class PageInputForwarder {
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  /** 这次按下被接走了（打开了面板画的下拉框），配对的那次抬起也不送。 */
  private swallowUp = false;

  constructor(
    private readonly contents: WebContents,
    private readonly platform: NodeJS.Platform = process.platform,
    /** 左键按下之前先问一句：返回 true 表示这一下由面板接走了，不送进页面。 */
    private readonly interceptDown?: (point: { x: number; y: number }) => Promise<boolean>,
    private readonly isCurrent: () => boolean = () => true,
    /** 空格、回车、Alt+↓ 按下之前先问一句（打开下拉框、日期和颜色选择器的键）。 */
    private readonly interceptKey?: (key: { key: string; alt: boolean }) => Promise<boolean>,
    /** 页面里的拖拽（见 browser-page-drags.ts）：用户拖着东西时，鼠标移动、松手换成拖拽送。 */
    private readonly drags?: {
      userMouse(event: Extract<BrowserPageInput, { kind: "mouse" }>): Promise<boolean>;
      userEscape(): Promise<boolean>;
    },
  ) {}

  /** 焦点进出不在这里：页面有没有焦点要和 Agent 那边合起来算，由 BrowserRuntimeManager 管。 */
  forward(input: Exclude<BrowserPageInput, { kind: "focus" }>, pageSize: { width: number; height: number }): void {
    const contents = this.contents;
    const generation = this.generation;
    const current = (): boolean => generation === this.generation && !contents.isDestroyed() && this.isCurrent();
    if (!current()) return;
    this.queue = this.queue.then(async () => {
      if (!current()) return;
      switch (input.kind) {
        case "mouse": {
          const event = clampToPage(input, pageSize);
          if (this.drags && await this.drags.userMouse(event).catch(() => false)) return;
          if (!current()) return;
          if (event.type === "down" && event.button === "left") {
            this.swallowUp = false;
            // 只有单击可能打开下拉框；双击、三击选词选段不必再问页面，省一次往返。
            if (event.clickCount === 1 && this.interceptDown && await this.interceptDown(event).catch(() => false)) {
              if (current()) this.swallowUp = true;
              return;
            }
          }
          if (!current()) return;
          if (this.swallowUp) {
            if (event.type === "up" && event.button === "left") {
              this.swallowUp = false;
              return;
            }
            // 被接走的那次按压期间，移动不送，免得页面以为在拖动；左键已经松开（配对的抬起
            // 在别处丢了，例如按下后切走又切回），这次按压就算结束，悬停照常送。
            if (event.type === "move") {
              if (event.buttons & 1) return;
              this.swallowUp = false;
            }
          }
          contents.sendInputEvent(mouseInputEvent(event));
          return;
        }
        case "wheel":
          contents.sendInputEvent(wheelInputEvent(clampToPage(input, pageSize)));
          return;
        case "edit":
          this.edit(input.command);
          return;
        case "key":
          if (input.type === "down" && input.key === "Escape" && this.drags && await this.drags.userEscape().catch(() => false)) return;
          if (input.type === "down" && !input.modifiers.control && !input.modifiers.meta
            && (input.key === " " || input.key === "Enter" || (input.key === "ArrowDown" && input.modifiers.alt))
            && this.interceptKey && await this.interceptKey({ key: input.key, alt: input.modifiers.alt }).catch(() => false)) return;
          if (current()) await this.send(input);
          return;
        default:
          await this.send(input);
      }
    }).catch((error: unknown) => {
      // 失败只影响这一步，不能让后续鼠标、键盘整条队列失效。
      console.warn("[browser] 转发输入失败", input.kind, error instanceof Error ? error.message : error);
    });
  }

  /** 换页后仍在等命中测试的旧操作不能送进新页面。 */
  reset(): void {
    this.generation++;
    this.swallowUp = false;
  }

  private edit(command: Extract<BrowserPageInput, { kind: "edit" }>["command"]): void {
    const contents = this.contents;
    if (command === "copy") contents.copy();
    else if (command === "cut") contents.cut();
    else if (command === "paste") contents.paste();
    else if (command === "undo") contents.undo();
    else if (command === "redo") contents.redo();
    else contents.selectAll();
  }

  private async send(input: Exclude<BrowserPageInput, { kind: "mouse" | "wheel" | "edit" | "focus" }>): Promise<void> {
    const contents = this.contents;
    if (contents.isDestroyed()) return;
    const debug = contents.debugger;
    if (!debug.isAttached()) return;
    switch (input.kind) {
      case "key":
        await debug.sendCommand("Input.dispatchKeyEvent", keyEventParams(input, this.platform));
        return;
      case "ime":
        if (input.type === "update") {
          await debug.sendCommand("Input.imeSetComposition", { text: input.text, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd });
        } else if (input.type === "commit") {
          await debug.sendCommand("Input.insertText", { text: input.text });
        } else {
          // 放弃组字：把页面里那段带下划线的组字清掉。
          await debug.sendCommand("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
        }
        return;
      case "text":
        await debug.sendCommand("Input.insertText", { text: input.text });
        return;
    }
  }
}

const CSS_CURSORS: Record<string, string> = {
  default: "default",
  pointer: "pointer",
  hand: "pointer",
  text: "text",
  "vertical-text": "vertical-text",
  crosshair: "crosshair",
  wait: "wait",
  progress: "progress",
  help: "help",
  move: "move",
  cell: "cell",
  "context-menu": "context-menu",
  alias: "alias",
  copy: "copy",
  "no-drop": "no-drop",
  nodrop: "no-drop",
  "not-allowed": "not-allowed",
  grab: "grab",
  grabbing: "grabbing",
  "zoom-in": "zoom-in",
  "zoom-out": "zoom-out",
  none: "none",
  "e-resize": "e-resize",
  "n-resize": "n-resize",
  "ne-resize": "ne-resize",
  "nw-resize": "nw-resize",
  "s-resize": "s-resize",
  "se-resize": "se-resize",
  "sw-resize": "sw-resize",
  "w-resize": "w-resize",
  "ns-resize": "ns-resize",
  "ew-resize": "ew-resize",
  "nesw-resize": "nesw-resize",
  "nwse-resize": "nwse-resize",
  "col-resize": "col-resize",
  "row-resize": "row-resize",
  "all-scroll": "all-scroll",
};

/** 页面要的光标换成 CSS 的写法；网页自己画的光标（custom）带上图片和热点。 */
export function cssCursor(type: string, image?: NativeImage, hotspot?: { x: number; y: number }): string {
  if (type === "custom" && image && !image.isEmpty()) {
    const x = Math.max(0, Math.round(hotspot?.x ?? 0));
    const y = Math.max(0, Math.round(hotspot?.y ?? 0));
    return `url("${image.toDataURL()}") ${x} ${y}, default`;
  }
  return CSS_CURSORS[type] ?? "default";
}
