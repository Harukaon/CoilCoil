import type { WebContents } from "electron";
import type { BrowserElementSelection, BrowserElementSourceLocation } from "../shared/desktop-api";
import { captureGuestElement } from "./browser-capture";

const OUTER_HTML_LIMIT = 16_000;
const TEXT_LIMIT = 1_500;

const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: true,
  showAccessibilityInfo: true,
  contentColor: { r: 16, g: 185, b: 129, a: 0.16 },
  paddingColor: { r: 52, g: 211, b: 153, a: 0.22 },
  borderColor: { r: 5, g: 150, b: 105, a: 0.9 },
  marginColor: { r: 110, g: 231, b: 183, a: 0.12 },
} as const;

interface PageElementMetadata {
  tagName?: unknown;
  selector?: unknown;
  xpath?: unknown;
  text?: unknown;
  attributes?: unknown;
  styles?: unknown;
  component?: unknown;
  componentProps?: unknown;
  source?: unknown;
}

interface ActivePick {
  guest: WebContents;
  listener: (event: Electron.Event, method: string, params: unknown) => void;
  cancelOnNavigation: () => void;
  resolve: (selection: BrowserElementSelection | undefined) => void;
  reject: (error: unknown) => void;
  finishing: boolean;
}

function clipped(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 14))}\n…[truncated]`;
}

/** Remove the fields most likely to contain credentials before markup reaches a model. */
export function sanitizeSelectedOuterHtml(value: string): string {
  const withoutExecutableBodies = value
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, "$1…[script omitted]$2")
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, "$1…[style omitted]$2");
  const withoutSensitiveAttributes = withoutExecutableBodies.replace(
    /\s([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g,
    (match, name: string) => {
      const normalized = name.toLowerCase();
      const sensitive = normalized === "value"
        || normalized === "srcdoc"
        || /(?:^|[-_:])(?:password|passwd|token|secret|authorization|auth|cookie)(?:$|[-_:])/.test(normalized);
      return sensitive ? ` ${name}="[redacted]"` : match;
    },
  );
  return clipped(withoutSensitiveAttributes, OUTER_HTML_LIMIT);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .slice(0, 40));
}

function scalarRecord(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] => {
    const item = entry[1];
    return item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean";
  }).slice(0, 16);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function sourceLocation(value: unknown): BrowserElementSourceLocation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.file !== "string" || !record.file.trim()) return undefined;
  return {
    file: record.file.slice(0, 2_000),
    ...typeof record.line === "number" && Number.isFinite(record.line) ? { line: Math.max(1, Math.round(record.line)) } : {},
    ...typeof record.column === "number" && Number.isFinite(record.column) ? { column: Math.max(1, Math.round(record.column)) } : {},
  };
}

function boundsFromBoxModel(value: unknown): BrowserElementSelection["bounds"] {
  if (!value || typeof value !== "object") return undefined;
  const model = (value as { model?: { border?: unknown; content?: unknown } }).model;
  const quad = Array.isArray(model?.border) ? model.border : Array.isArray(model?.content) ? model.content : undefined;
  if (!quad || quad.length < 8 || quad.some((item) => typeof item !== "number" || !Number.isFinite(item))) return undefined;
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(0, Math.round(Math.max(...xs) - left)),
    height: Math.max(0, Math.round(Math.max(...ys) - top)),
  };
}

/**
 * Executed against the selected node in the page's main world.
 *
 * Framework metadata is deliberately best-effort: Vite/Vue inspector markers
 * are public page data, while React Fiber fields are private and may change.
 * DOM identity remains useful when none of these hints exist.
 */
function readPageElementMetadata(this: Element): PageElementMetadata {
  const element = this;
  const doc = element.ownerDocument;
  const escapeCss = (value: string): string => {
    const nativeEscape = globalThis.CSS?.escape;
    if (nativeEscape) return nativeEscape(value);
    return value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match) => `\\${match.codePointAt(0)?.toString(16)} `);
  };
  const selectorPart = (node: Element): string => {
    const tag = node.tagName.toLowerCase();
    if (node.id && doc.querySelectorAll(`#${escapeCss(node.id)}`).length === 1) return `#${escapeCss(node.id)}`;
    const classes = [...node.classList]
      .filter((name) => name.length <= 80 && !/\d{5,}/.test(name))
      .slice(0, 3)
      .map((name) => `.${escapeCss(name)}`)
      .join("");
    let part = `${tag}${classes}`;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    return part;
  };
  const selector = (() => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 7) {
      const part = selectorPart(current);
      parts.unshift(part);
      const candidate = parts.join(" > ");
      try {
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        // Keep walking; an odd class name should not abort the pick.
      }
      if (part.startsWith("#")) return candidate;
      current = current.parentElement;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  })();
  const xpath = (() => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((child) => child.tagName === current!.tagName)
        : [];
      parts.unshift(`${tag}${siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : ""}`);
      current = current.parentElement;
    }
    return `/${parts.join("/")}`;
  })();
  const sensitive = /pass|token|secret|auth|cookie/i;
  const attributes = Object.fromEntries([...element.attributes]
    .filter((attribute) => !attribute.name.toLowerCase().startsWith("on"))
    .filter((attribute) => attribute.name !== "value" && !sensitive.test(attribute.name))
    .slice(0, 40)
    .map((attribute) => [attribute.name, attribute.value.slice(0, 500)]));
  const computed = globalThis.getComputedStyle(element);
  const styleNames = [
    "display", "position", "box-sizing", "width", "height", "min-width", "min-height", "max-width", "max-height",
    "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "color", "background-color", "border-top-width", "border-top-color", "border-radius", "box-shadow", "opacity",
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
    "flex-direction", "align-items", "justify-content", "gap", "grid-template-columns", "grid-template-rows", "z-index",
  ];
  const styles = Object.fromEntries(styleNames.map((name) => [name, computed.getPropertyValue(name)]).filter(([, value]) => value));
  const scalarProps = (value: unknown): Record<string, string | number | boolean | null> | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([name, item]) => !sensitive.test(name) && (item === null || ["string", "number", "boolean"].includes(typeof item)))
      .slice(0, 16) as Array<[string, string | number | boolean | null]>;
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  const parseSource = (raw: unknown): { file: string; line?: number; column?: number } | undefined => {
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const file = typeof record.fileName === "string" ? record.fileName : typeof record.file === "string" ? record.file : undefined;
      if (file) return {
        file,
        ...typeof record.lineNumber === "number" ? { line: record.lineNumber } : typeof record.line === "number" ? { line: record.line } : {},
        ...typeof record.columnNumber === "number" ? { column: record.columnNumber } : typeof record.column === "number" ? { column: record.column } : {},
      };
    }
    if (typeof raw !== "string") return undefined;
    const match = raw.match(/^(.*):(\d+):(\d+)(?::[^:]*)?$/);
    return match ? { file: match[1], line: Number(match[2]), column: Number(match[3]) } : { file: raw };
  };

  let component: string | undefined;
  let componentProps: Record<string, string | number | boolean | null> | undefined;
  let source = parseSource(element.getAttribute("data-v-inspector")
    ?? element.getAttribute("data-source")
    ?? element.getAttribute("data-inspector"));
  const privateElement = element as Element & Record<string, unknown>;
  const fiberKey = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
  let fiber = fiberKey ? privateElement[fiberKey] as Record<string, unknown> | undefined : undefined;
  for (let depth = 0; fiber && depth < 30; depth += 1) {
    const type = fiber.elementType ?? fiber.type;
    if (typeof type === "function" || (type && typeof type === "object")) {
      const typed = type as { displayName?: unknown; name?: unknown };
      const name = typeof typed.displayName === "string" ? typed.displayName : typeof typed.name === "string" ? typed.name : undefined;
      if (name) {
        component = name;
        componentProps = scalarProps(fiber.memoizedProps);
        source ??= parseSource(fiber._debugSource)
          ?? parseSource((fiber.memoizedProps as Record<string, unknown> | undefined)?.__source);
        break;
      }
    }
    fiber = fiber.return as Record<string, unknown> | undefined;
  }
  const vue = privateElement.__vueParentComponent as Record<string, unknown> | undefined;
  if (vue) {
    const type = vue.type as Record<string, unknown> | undefined;
    component ??= typeof type?.name === "string" ? type.name : typeof type?.__name === "string" ? type.__name : undefined;
    componentProps ??= scalarProps(vue.props);
    source ??= parseSource(type?.__file);
  }

  return {
    tagName: element.tagName.toLowerCase(),
    selector,
    xpath,
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1_500),
    attributes,
    styles,
    component,
    componentProps,
    source,
  };
}

async function collectSelection(guest: WebContents, backendNodeId: number): Promise<BrowserElementSelection> {
  const debug = guest.debugger;
  const [htmlResult, boxResult, resolved] = await Promise.all([
    debug.sendCommand("DOM.getOuterHTML", { backendNodeId, includeShadowDOM: true }).catch(() => ({ outerHTML: "" })) as Promise<{ outerHTML?: unknown }>,
    debug.sendCommand("DOM.getBoxModel", { backendNodeId }).catch(() => undefined),
    debug.sendCommand("DOM.resolveNode", { backendNodeId, objectGroup: "coilcoil-element-picker" }) as Promise<{ object?: { objectId?: unknown } }>,
  ]);
  const objectId = resolved.object?.objectId;
  if (typeof objectId !== "string") throw new Error("无法读取所选网页元素。");
  const evaluated = await debug.sendCommand("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: readPageElementMetadata.toString(),
    returnByValue: true,
    awaitPromise: false,
  }) as { result?: { value?: unknown } };
  void debug.sendCommand("Runtime.releaseObjectGroup", { objectGroup: "coilcoil-element-picker" }).catch(() => undefined);
  const metadata = evaluated.result?.value && typeof evaluated.result.value === "object"
    ? evaluated.result.value as PageElementMetadata
    : {};
  const selector = typeof metadata.selector === "string" && metadata.selector ? metadata.selector : "unknown-element";
  const componentProps = scalarRecord(metadata.componentProps);
  const source = sourceLocation(metadata.source);
  const bounds = boundsFromBoxModel(boxResult);
  return {
    pageUrl: guest.getURL(),
    pageTitle: guest.getTitle(),
    tagName: typeof metadata.tagName === "string" ? metadata.tagName : "unknown",
    selector: clipped(selector, 2_000),
    xpath: typeof metadata.xpath === "string" ? clipped(metadata.xpath, 4_000) : "",
    outerHtml: sanitizeSelectedOuterHtml(typeof htmlResult.outerHTML === "string" ? htmlResult.outerHTML : ""),
    ...typeof metadata.text === "string" && metadata.text ? { text: clipped(metadata.text, TEXT_LIMIT) } : {},
    attributes: stringRecord(metadata.attributes),
    styles: stringRecord(metadata.styles),
    ...typeof metadata.component === "string" && metadata.component ? { component: clipped(metadata.component, 300) } : {},
    ...componentProps ? { componentProps } : {},
    ...source ? { source } : {},
    ...bounds ? { bounds } : {},
  };
}

/** One-shot native Chromium element picker shared by all tabs in a window. */
export class BrowserElementPicker {
  private active?: ActivePick;

  get picking(): boolean {
    return Boolean(this.active);
  }

  async pick(guest: WebContents): Promise<BrowserElementSelection | undefined> {
    this.cancel();
    if (guest.isDestroyed()) throw new Error("内置浏览器视图不可用。");
    await guest.debugger.sendCommand("DOM.enable");
    await guest.debugger.sendCommand("Overlay.enable");

    const result = new Promise<BrowserElementSelection | undefined>((resolve, reject) => {
      const cancelOnNavigation = (): void => this.cancel();
      const listener = (_event: Electron.Event, method: string, params: unknown): void => {
        if (method === "Overlay.inspectModeCanceled") {
          this.cancel();
          return;
        }
        if (method !== "Overlay.inspectNodeRequested" || !params || typeof params !== "object") return;
        const backendNodeId = (params as { backendNodeId?: unknown }).backendNodeId;
        if (typeof backendNodeId !== "number" || !Number.isFinite(backendNodeId)) return;
        const active = this.active;
        if (!active || active.guest !== guest || active.finishing) return;
        active.finishing = true;
        void this.complete(active, backendNodeId);
      };
      this.active = { guest, listener, cancelOnNavigation, resolve, reject, finishing: false };
      guest.debugger.on("message", listener);
      guest.on("did-start-navigation", cancelOnNavigation);
      guest.on("destroyed", cancelOnNavigation);
      guest.on("render-process-gone", cancelOnNavigation);
    });

    try {
      await guest.debugger.sendCommand("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: HIGHLIGHT_CONFIG,
      });
    } catch (error) {
      this.fail(this.active, error);
    }
    return result;
  }

  cancel(): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.detach(active);
    if (!active.guest.isDestroyed() && active.guest.debugger.isAttached()) {
      void active.guest.debugger.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: HIGHLIGHT_CONFIG }).catch(() => undefined);
      void active.guest.debugger.sendCommand("Overlay.hideHighlight").catch(() => undefined);
    }
    active.resolve(undefined);
  }

  private async complete(active: ActivePick, backendNodeId: number): Promise<void> {
    try {
      await active.guest.debugger.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: HIGHLIGHT_CONFIG });
      await active.guest.debugger.sendCommand("Overlay.highlightNode", { backendNodeId, highlightConfig: HIGHLIGHT_CONFIG });
      const selection = await collectSelection(active.guest, backendNodeId);
      // The overlay is useful while choosing, but must not become part of the
      // context image. Capture the element's own box instead of the whole guest.
      await active.guest.debugger.sendCommand("Overlay.hideHighlight").catch(() => undefined);
      selection.screenshot = await captureGuestElement(active.guest, selection.bounds);
      if (this.active !== active) return;
      this.active = undefined;
      this.detach(active);
      await active.guest.debugger.sendCommand("Overlay.hideHighlight").catch(() => undefined);
      active.resolve(selection);
    } catch (error) {
      this.fail(active, error);
    }
  }

  private fail(active: ActivePick | undefined, error: unknown): void {
    if (!active || this.active !== active) return;
    this.active = undefined;
    this.detach(active);
    if (!active.guest.isDestroyed() && active.guest.debugger.isAttached()) {
      void active.guest.debugger.sendCommand("Overlay.hideHighlight").catch(() => undefined);
    }
    active.reject(error);
  }

  private detach(active: ActivePick): void {
    active.guest.debugger.off("message", active.listener);
    active.guest.off("did-start-navigation", active.cancelOnNavigation);
    active.guest.off("destroyed", active.cancelOnNavigation);
    active.guest.off("render-process-gone", active.cancelOnNavigation);
  }
}
