/**
 * 内置浏览器的网页不许悄悄把焦点抢走。
 *
 * 网页是嵌在 App 窗口里的 <webview>。Agent 在网页里点击、填表，或者网页自己加载完
 * 自动聚焦某个输入框，Chromium 都会把焦点从 App 挪进这个 <webview>：用户正在输入框里
 * 打字，光标突然没了，接着打的字全进了网页。
 *
 * 规则：用户自己要进网页时（鼠标正停在网页上点进去，或者刚按了 Tab），网页拿焦点
 * 天经地义。Agent 正在往网页里输入时，焦点也得先归网页——键盘命令是发给有焦点的
 * 页面的，焦点在这边的话 Agent 打的字会进用户的输入框（见 main/browser-agent-focus.ts）；
 * 等这阵输入停下来再还。其余情况（网页自己抢的）焦点一落到 <webview> 上就放回原处。
 * 放回时连光标位置（选区）一起：打到一半的字、光标都不变。网页那边不会因此收到
 * blur（端到端测试 browser-focus 盯着），下拉建议之类不会被收起。
 */
interface FocusMemory {
  element: HTMLElement;
  ranges: Range[];
}

const TAB_INTENT_MS = 500;

function isWebview(target: EventTarget | null): boolean {
  return target instanceof Element && target.tagName === "WEBVIEW";
}

function selectionInside(element: HTMLElement): Range[] {
  const selection = window.getSelection();
  if (!selection) return [];
  const ranges: Range[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (element.contains(range.commonAncestorContainer)) ranges.push(range.cloneRange());
  }
  return ranges;
}

export function installBrowserFocusReturn(target: Document = document): () => void {
  const view = target.defaultView ?? window;
  let memory: FocusMemory | undefined;
  let pointerOverWebview = false;
  let tabPressedAt = 0;
  let agentInputUntil = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  // 鼠标从 App 移进网页时，外面这层只看得到 <webview> 元素本身收到 mouseover；
  // 移回 App 任何地方，mouseover 的目标就不是它了。
  const trackPointer = (event: MouseEvent): void => { pointerOverWebview = isWebview(event.target); };
  const trackTab = (event: KeyboardEvent): void => { if (event.key === "Tab") tabPressedAt = Date.now(); };
  // 焦点进网页时外面这层不发 focusout（和进跨域 iframe 一样），所以焦点落在哪、光标
  // 在哪要随时记着，而不是等离开时再记。
  const rememberFocus = (event: FocusEvent): void => {
    if (event.target instanceof HTMLElement && !isWebview(event.target)) memory = { element: event.target, ranges: selectionInside(event.target) };
  };
  const rememberCaret = (): void => {
    if (memory && memory.element === target.activeElement) memory.ranges = selectionInside(memory.element);
  };
  const restore = (): void => {
    pending = undefined;
    if (!isWebview(target.activeElement) || pointerOverWebview || Date.now() - tabPressedAt < TAB_INTENT_MS) return;
    // Agent 这阵输入还没停：焦点先留给网页，停了再还。
    if (Date.now() < agentInputUntil) {
      schedule(agentInputUntil - Date.now());
      return;
    }
    const saved = memory;
    if (!saved?.element.isConnected) return;
    view.focus();
    saved.element.focus({ preventScroll: true });
    if (!saved.ranges.length) return;
    const selection = view.getSelection();
    selection?.removeAllRanges();
    for (const range of saved.ranges) selection?.addRange(range);
  };
  const schedule = (delay: number): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(restore, delay);
  };
  // 焦点被网页拿走时，App 这一层收到的是 window 的 blur，activeElement 变成 <webview>。
  // 稍等一下再看：这次切换得走完，主进程「Agent 在输入」的通知也可能晚一步到。
  const onBlur = (): void => { schedule(30); };
  const unsubscribe = window.coilcoil.onBrowserAgentInput((holdMs) => {
    agentInputUntil = Date.now() + holdMs;
    if (pending) schedule(holdMs);
  });

  target.addEventListener("mouseover", trackPointer, true);
  target.addEventListener("keydown", trackTab, true);
  target.addEventListener("focusin", rememberFocus, true);
  target.addEventListener("selectionchange", rememberCaret);
  view.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("mouseover", trackPointer, true);
    target.removeEventListener("keydown", trackTab, true);
    target.removeEventListener("focusin", rememberFocus, true);
    target.removeEventListener("selectionchange", rememberCaret);
    view.removeEventListener("blur", onBlur);
    if (pending) clearTimeout(pending);
    unsubscribe();
  };
}
