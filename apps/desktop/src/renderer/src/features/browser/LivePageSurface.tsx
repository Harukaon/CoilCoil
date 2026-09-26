import { Bot, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserInputModifiers, BrowserPageInput, BrowserTabSnapshot } from "../../../../shared/desktop-api";
import { rendererPlatform } from "../../platform";

/**
 * 面板里的一张离屏页面：显示它的实时画面，用户在画面上的操作原样送进页面。
 *
 * 页面本身在主进程里离屏渲染（browser-offscreen.ts），Agent 也在操作同一个页面——
 * 没有接管，也不刷新。用户的鼠标、滚轮落在画面上，按画面对应的页面位置送过去；键盘
 * 和输入法先落在一个看不见的输入框（焦点代理）里，由它把按键、组字过程转成页面的
 * 输入。用户点回 App 别处，焦点代理失焦，页面也跟着失焦。
 *
 * Agent 怎么操作都碰不到这个输入框：它的点击和打字只进离屏页面，所以用户在对话框里
 * 打字时，焦点一直在对话框里。
 *
 * `remoteFrame` 是网页版、手机用的：它们拿的是定时截图，只看不点。
 */
export function LivePageSurface({ tab, scopeId, remoteFrame, onReload, onBack, onForward, onFocusAddress }: {
  tab: BrowserTabSnapshot;
  scopeId: string;
  remoteFrame?: string;
  onReload(): void;
  onBack(): void;
  onForward(): void;
  onFocusAddress(): void;
}): React.JSX.Element {
  const [frame, setFrame] = useState<string>();
  const [cursor, setCursor] = useState("default");
  const [proxyAt, setProxyAt] = useState({ x: 0, y: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<HTMLTextAreaElement>(null);
  /** 最近一帧画的页面有多大：用户点画面上哪儿，按这一帧换算成页面上的位置。 */
  const viewportRef = useRef<{ width: number; height: number } | undefined>(undefined);
  const interactive = remoteFrame === undefined;

  useEffect(() => {
    setFrame(undefined);
    viewportRef.current = undefined;
    if (!interactive) return;
    let current: string | undefined;
    const stop = window.coilcoil.onBrowserFrame((next) => {
      if (next.tabId !== tab.id) return;
      viewportRef.current = next.viewport;
      const url = URL.createObjectURL(new Blob([next.data as BlobPart], { type: "image/jpeg" }));
      setFrame(url);
      if (current) URL.revokeObjectURL(current);
      current = url;
    });
    return () => {
      stop();
      if (current) URL.revokeObjectURL(current);
    };
  }, [interactive, tab.id]);

  useEffect(() => {
    setCursor("default");
    if (!interactive) return;
    return window.coilcoil.onBrowserPageEvent((event) => {
      if (event.tabId === tab.id && event.kind === "cursor") setCursor(event.cursor);
    });
  }, [interactive, tab.id]);

  const send = useCallback((input: BrowserPageInput): void => {
    window.coilcoil.sendBrowserInput(scopeId, tab.id, input);
  }, [scopeId, tab.id]);

  /**
   * 画面上的一点对应页面上的哪一点。
   *
   * 画面按页面比例贴在左上角（object-fit: contain），页面和面板一样大时一比一；Agent
   * 把页面调成手机尺寸时会缩放。落在画面外的（缩放后留出的空白）不算点到页面。
   */
  const pagePoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    if (!root || !viewport || viewport.width <= 0 || viewport.height <= 0) return undefined;
    const box = root.getBoundingClientRect();
    const scale = Math.min(box.width / viewport.width, box.height / viewport.height);
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    const x = (clientX - box.left) / scale;
    const y = (clientY - box.top) / scale;
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return undefined;
    return { x, y };
  }, []);

  // 鼠标移动一帧只送一次最新的位置；按下、抬起、滚轮之前先把攒着的那次送掉，顺序不能乱。
  const pendingMove = useRef<{ clientX: number; clientY: number; buttons: number; modifiers: BrowserInputModifiers } | undefined>(undefined);
  const moveFrame = useRef(0);
  const flushMove = useCallback((): void => {
    if (moveFrame.current) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = 0;
    const move = pendingMove.current;
    pendingMove.current = undefined;
    if (!move) return;
    const point = pagePoint(move.clientX, move.clientY);
    if (!point) return;
    send({ kind: "mouse", type: "move", ...point, button: "none", clickCount: 0, buttons: move.buttons, modifiers: move.modifiers });
  }, [pagePoint, send]);
  useEffect(() => () => { if (moveFrame.current) cancelAnimationFrame(moveFrame.current); }, []);

  const sendButton = (event: React.MouseEvent, type: "down" | "up"): void => {
    const button = event.button === 0 ? "left" : event.button === 1 ? "middle" : event.button === 2 ? "right" : undefined;
    if (!button) return;
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    flushMove();
    send({ kind: "mouse", type, ...point, button, clickCount: Math.max(1, event.detail), buttons: event.buttons, modifiers: modifiersOf(event) });
  };

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    // 不让 App 自己处理这次按下（选中文字、把焦点给别的元素）；焦点交给焦点代理。
    event.preventDefault();
    // 鼠标侧键：后退、前进，和浏览器一样。
    if (event.button === 3) { onBack(); return; }
    if (event.button === 4) { onForward(); return; }
    const root = rootRef.current;
    if (root) {
      const box = root.getBoundingClientRect();
      // 输入法的候选框跟着焦点代理走，放在用户点的地方，候选框就出现在他打字的位置附近。
      setProxyAt({ x: Math.max(0, event.clientX - box.left), y: Math.max(0, event.clientY - box.top) });
    }
    proxyRef.current?.focus({ preventScroll: true });
    sendButton(event, "down");
  };

  // 拖动时指针跑出画面也要继续跟：按下时把指针抓在这一层上，松开之前的移动和抬起都归它。
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    pendingMove.current = { clientX: event.clientX, clientY: event.clientY, buttons: event.buttons, modifiers: modifiersOf(event) };
    if (!moveFrame.current) moveFrame.current = requestAnimationFrame(flushMove);
  };

  const onPointerLeave = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.buttons) return;
    flushMove();
    send({ kind: "mouse", type: "leave", x: 0, y: 0, button: "none", clickCount: 0, buttons: 0, modifiers: modifiersOf(event) });
  };

  // 滚轮要拦下 App 自己的滚动和缩放，React 的 onWheel 是被动监听拦不住，所以自己挂。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !interactive) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      flushMove();
      // 按行、按页滚的鼠标（deltaMode 1、2）换成像素，页面里的滚动距离才对。
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? root.clientHeight : 1;
      send({ kind: "wheel", ...point, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: modifiersOf(event) });
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [flushMove, interactive, pagePoint, send]);

  const keyboard = useSurfaceKeyboard({ send, onReload, onBack, onForward, onFocusAddress });

  // 用户点回 App 别处（焦点代理失焦）或者这张页面不再显示：告诉页面它失焦了。
  const focusedRef = useRef(false);
  useEffect(() => () => {
    if (focusedRef.current) send({ kind: "focus", focused: false });
  }, [send]);

  const shown = remoteFrame ?? frame;
  return (
    <div className={`browser-live-page ${interactive ? "interactive" : ""}`} ref={rootRef}>
      {shown
        ? <img className="browser-live-frame" src={shown} alt={tab.title} draggable={false} />
        : <div className="browser-empty"><LoaderCircle className="spin" size={20} /><strong>正在读取页面…</strong></div>}
      {interactive ? (
        <div
          className="browser-live-input"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onMouseDown={onMouseDown}
          onMouseUp={(event) => sendButton(event, "up")}
          onContextMenu={(event) => event.preventDefault()}
        />
      ) : null}
      {interactive ? (
        <textarea
          ref={proxyRef}
          className="browser-live-proxy"
          style={{ left: proxyAt.x, top: proxyAt.y }}
          aria-label={`网页：${tab.title}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          tabIndex={-1}
          onFocus={() => { focusedRef.current = true; send({ kind: "focus", focused: true }); }}
          onBlur={() => { focusedRef.current = false; send({ kind: "focus", focused: false }); }}
          {...keyboard}
        />
      ) : null}
      {tab.agent ? (
        // 这页 Agent 在用：四周一圈流动的渐变描边，底部一团呼吸的光晕。都不挡操作；用户
        // 把鼠标移上来、或者正在页面里打字时，底部那团光和提示条淡出，不挡他看页面。
        <>
          <div className="browser-agent-presence" aria-hidden="true">
            <div className="browser-agent-ring" />
            <div className="browser-agent-veil" />
            <div className="browser-agent-glow" />
          </div>
          <div className="browser-agent-bar" role="status">
            <span className="browser-agent-pulse" aria-hidden="true" />
            <Bot className="browser-agent-label" size={14} />
            <span className="browser-agent-label">Agent 也在使用这个页面</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

function modifiersOf(event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): BrowserInputModifiers {
  return { shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey };
}

/**
 * 这些组合键归 App（新建对话、设置）或系统菜单（退出、隐藏、最小化、关窗口、缩放
 * 界面、开发者工具），不送进页面，也不拦，照常往上传。
 */
function isAppShortcut(event: React.KeyboardEvent, mac: boolean): boolean {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod) return false;
  const key = event.key.toLowerCase();
  if (["n", ",", "q", "h", "m", "w", "=", "+", "-", "0", "`"].includes(key)) return true;
  return event.altKey && key === "i";
}

/**
 * 焦点代理上的键盘和输入法。
 *
 * - 普通按键：原样送进页面，并拦下（输入框里不留字、App 的快捷键不跟着动）。
 * - 输入法组字：按键不送（keyCode 229），组字过程和结果单独送，页面收到完整的组字事件。
 * - 浏览器自己的快捷键（⌘L 地址栏、⌘R 刷新、⌘[ ⌘] 前进后退）由面板处理。
 * - 表情面板、听写这些不经键盘插进来的字，当文字送过去。
 * - 菜单栏「编辑」里的复制粘贴会落在焦点代理上，转成对页面的复制粘贴；按 ⌘C 这类
 *   快捷键时已经随按键送过，菜单那一下就不再送第二遍。
 */
function useSurfaceKeyboard({ send, onReload, onBack, onForward, onFocusAddress }: {
  send(input: BrowserPageInput): void;
  onReload(): void;
  onBack(): void;
  onForward(): void;
  onFocusAddress(): void;
}): Pick<React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onKeyDown" | "onKeyUp" | "onCompositionUpdate" | "onCompositionEnd" | "onInput" | "onCopy" | "onCut" | "onPaste" | "onBeforeInput"> {
  const mac = rendererPlatform() === "darwin";
  const pressed = useRef(new Set<string>());
  const composing = useRef(false);
  /** 刚随按键送过的编辑命令，菜单栏紧跟着再触发一次时不重复送。 */
  const recentEdit = useRef<{ command: string; at: number } | undefined>(undefined);

  const clear = (element: HTMLTextAreaElement): void => { if (element.value) element.value = ""; };

  const editOnce = (command: "copy" | "cut" | "paste" | "undo" | "redo"): void => {
    const recent = recentEdit.current;
    if (recent && recent.command === command && Date.now() - recent.at < 400) return;
    send({ kind: "edit", command });
  };

  return {
    onKeyDown: (event) => {
      const native = event.nativeEvent;
      if (native.isComposing || event.keyCode === 229 || event.key === "Dead" || event.key === "Process" || composing.current) return;
      const mod = mac ? event.metaKey : event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase();
        const panel = key === "l" ? onFocusAddress : key === "r" ? onReload : key === "[" ? onBack : key === "]" ? onForward : undefined;
        if (panel) {
          event.preventDefault();
          event.stopPropagation();
          panel();
          return;
        }
      }
      if (isAppShortcut(event, mac)) return;
      event.preventDefault();
      event.stopPropagation();
      if (mod) {
        const key = event.key.toLowerCase();
        const command = key === "c" ? "copy" : key === "x" ? "cut" : key === "v" ? "paste" : key === "z" ? (event.shiftKey ? "redo" : "undo") : undefined;
        if (command) recentEdit.current = { command, at: Date.now() };
      }
      pressed.current.add(event.code);
      send({
        kind: "key",
        type: "down",
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        location: event.location,
        repeat: event.repeat,
        modifiers: modifiersOf(event),
      });
    },
    onKeyUp: (event) => {
      if (!pressed.current.delete(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      send({
        kind: "key",
        type: "up",
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        location: event.location,
        repeat: false,
        modifiers: modifiersOf(event),
      });
    },
    onCompositionUpdate: (event) => {
      composing.current = true;
      const text = event.data;
      send({ kind: "ime", type: "update", text, selectionStart: text.length, selectionEnd: text.length });
    },
    onCompositionEnd: (event) => {
      composing.current = false;
      const text = event.data;
      send(text ? { kind: "ime", type: "commit", text } : { kind: "ime", type: "cancel" });
      clear(event.currentTarget);
    },
    onInput: (event) => {
      const native = event.nativeEvent as InputEvent;
      const element = event.currentTarget;
      if (native.isComposing || composing.current || native.inputType === "insertCompositionText") return;
      // 按键打的字在按下时就送过、也拦下了；走到这里的是表情面板、听写这类直接插进来的字。
      if (native.data && native.inputType.startsWith("insert")) send({ kind: "text", text: native.data });
      clear(element);
    },
    onBeforeInput: (event) => {
      const native = event.nativeEvent as InputEvent;
      if (native.inputType === "historyUndo" || native.inputType === "historyRedo") {
        event.preventDefault();
        editOnce(native.inputType === "historyUndo" ? "undo" : "redo");
      }
    },
    onCopy: (event) => { event.preventDefault(); editOnce("copy"); },
    onCut: (event) => { event.preventDefault(); editOnce("cut"); },
    onPaste: (event) => { event.preventDefault(); editOnce("paste"); },
  };
}
