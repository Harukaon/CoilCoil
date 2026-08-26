/**
 * Turn a key press into an Electron accelerator, or say why it will not do.
 *
 * A global shortcut is taken from every other application on the machine, so a
 * bare letter or a lone modifier must never become one. Electron names the
 * cross-platform modifier `CommandOrControl`, which is also what makes a
 * recorded shortcut mean the same thing on the user's other machine.
 */
export type AcceleratorResult =
  | { ok: true; accelerator: string }
  | { ok: false; reason: string };

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock", "Dead"]);

/** Electron's own names for keys whose `event.key` is not usable as written. */
const NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Enter: "Return",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

export interface ShortcutKeyPress {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function acceleratorFromKeyPress(event: ShortcutKeyPress): AcceleratorResult {
  if (MODIFIER_KEYS.has(event.key)) return { ok: false, reason: "再按一个普通按键，比如字母或空格。" };

  const modifiers: string[] = [];
  // Command and Control collapse into one name so the same recording works on
  // whichever platform the user is on next.
  if (event.metaKey || event.ctrlKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (!modifiers.length) return { ok: false, reason: "全局快捷键至少要带一个修饰键（⌘ / Ctrl / Alt）。" };

  const named = NAMED_KEYS[event.key];
  const key = named
    ?? (event.key.length === 1 ? event.key.toUpperCase() : /^F\d{1,2}$/.test(event.key) ? event.key : undefined);
  if (!key) return { ok: false, reason: `不支持这个按键：${event.key}` };

  return { ok: true, accelerator: [...modifiers, key].join("+") };
}

/** How an accelerator is shown to the user: symbols on macOS, words elsewhere. */
export function formatAccelerator(accelerator: string, platform: "darwin" | "win32" | "linux"): string {
  const primary = platform === "darwin" ? "⌘" : "Ctrl";
  const alt = platform === "darwin" ? "⌥" : "Alt";
  const shift = platform === "darwin" ? "⇧" : "Shift";
  const separator = platform === "darwin" ? "" : "+";
  return accelerator
    .split("+")
    .map((part) => part === "CommandOrControl" || part === "CmdOrCtrl" ? primary : part === "Alt" ? alt : part === "Shift" ? shift : part)
    .join(separator);
}
