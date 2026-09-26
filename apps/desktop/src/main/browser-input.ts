import type { InputEvent, MouseInputEvent, MouseWheelInputEvent, NativeImage, WebContents } from "electron";
import type { BrowserInputModifiers, BrowserPageInput } from "../shared/desktop-api";

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
      if (!(typeof input.type === "string" && input.type in MOUSE_TYPES)) return undefined;
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
 * 键盘、输入法、焦点走调试器（和 Agent 用的是同一个，已经挂上）；它们按到达顺序
 * 排着发，一个没发完下一个等着——同一个页面上「按下 a」绝不能跑到「按下 b」后面。
 */
export class PageInputForwarder {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly contents: WebContents, private readonly platform: NodeJS.Platform = process.platform) {}

  /** 焦点进出不在这里：页面有没有焦点要和 Agent 那边合起来算，由 BrowserRuntimeManager 管。 */
  forward(input: Exclude<BrowserPageInput, { kind: "focus" }>, pageSize: { width: number; height: number }): void {
    const contents = this.contents;
    if (contents.isDestroyed()) return;
    switch (input.kind) {
      case "mouse":
        // 鼠标不排队：sendInputEvent 本身就按调用顺序进页面，排队只会让拖动发涩。
        contents.sendInputEvent(mouseInputEvent(clampToPage(input, pageSize)));
        return;
      case "wheel":
        contents.sendInputEvent(wheelInputEvent(clampToPage(input, pageSize)));
        return;
      case "edit":
        this.edit(input.command);
        return;
      default:
        this.enqueue(input);
    }
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

  private enqueue(input: Exclude<BrowserPageInput, { kind: "mouse" | "wheel" | "edit" | "focus" }>): void {
    this.queue = this.queue.then(() => this.send(input)).catch((error: unknown) => {
      // 页面正在跳转、刚关掉时会发不出去，丢掉这一下就好，别让后面的也跟着卡住。
      console.warn("[browser] 转发输入失败", input.kind, error instanceof Error ? error.message : error);
    });
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
