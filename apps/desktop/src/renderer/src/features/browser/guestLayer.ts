import type { BrowserGuestRoster } from "../../../../shared/desktop-api";

/**
 * Owns the `<webview>` elements backing the built-in browser.
 *
 * Deliberately imperative: React must never hold these nodes. Any reconciliation
 * that reorders or re-keys a `<webview>` detaches its guest, and `partition` cannot
 * be set again after the first navigation, so a recreated element can silently land
 * in the wrong session. The layer is mounted once at the app root and reconciled by
 * hand against the roster main publishes.
 *
 * Hiding is positional, never `display:none`/`visibility:hidden`/`opacity:0`/offscreen:
 * a guest that is not composited stops producing frames, and `Page.captureScreenshot`
 * then hangs forever. Inactive guests keep a 1x1 on-screen box and get their real
 * viewport from `Emulation.setDeviceMetricsOverride` in main.
 */

const PARTITION = "persist:suocode-browser";

interface GuestElement extends HTMLElement {
  getWebContentsId(): number;
}

interface GuestEntry {
  element: GuestElement;
  nonce: string;
  registered: boolean;
}

/** Where BrowserPanel wants the visible guest drawn, in CSS pixels. */
export interface GuestPlacement {
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

let layer: HTMLDivElement | undefined;
let placement: GuestPlacement | undefined;
const guests = new Map<string, GuestEntry>();

function applyPlacement(tabId: string, entry: GuestEntry): void {
  const visible = placement?.tabId === tabId && placement.width > 0 && placement.height > 0;
  const style = entry.element.style;
  if (visible && placement) {
    entry.element.classList.add("visible");
    style.left = `${Math.round(placement.x)}px`;
    style.top = `${Math.round(placement.y)}px`;
    style.width = `${Math.round(placement.width)}px`;
    style.height = `${Math.round(placement.height)}px`;
    return;
  }
  // Parked: still on-screen and composited, but a single pixel in the corner.
  entry.element.classList.remove("visible");
  style.left = "";
  style.top = "";
  style.width = "";
  style.height = "";
}

function createGuest(tabId: string, nonce: string): GuestEntry {
  const element = document.createElement("webview") as GuestElement;
  element.setAttribute("partition", PARTITION);
  // A guest with no src never fires did-attach, so it can never be registered.
  element.setAttribute("src", "about:blank");
  // window.open is converted into an in-app tab by the guest's own handler in main.
  element.setAttribute("allowpopups", "");
  element.dataset.tabId = tabId;
  const entry: GuestEntry = { element, nonce, registered: false };

  // getWebContentsId() throws until dom-ready, even though did-attach has fired.
  element.addEventListener("dom-ready", () => {
    if (entry.registered || !guests.has(tabId)) return;
    entry.registered = true;
    let webContentsId: number;
    try {
      webContentsId = element.getWebContentsId();
    } catch (error) {
      void window.suocode.reportBrowserGuestFailure(tabId, nonce, String(error));
      return;
    }
    void window.suocode.registerBrowserGuest(tabId, nonce, webContentsId).catch((error: unknown) => {
      // Main refused the binding. Drop the element rather than leave a live guest
      // that nothing owns.
      guests.delete(tabId);
      element.remove();
      console.error("[browser] guest registration rejected", error);
    });
  });

  element.addEventListener("destroyed", () => {
    if (!guests.has(tabId)) return;
    guests.delete(tabId);
    void window.suocode.reportBrowserGuestFailure(tabId, nonce, "guest destroyed");
  });

  return entry;
}

function reconcile(roster: BrowserGuestRoster): void {
  if (!layer) return;
  const wanted = new Map(roster.tabs.map((slot) => [slot.tabId, slot.nonce]));

  for (const [tabId, entry] of [...guests]) {
    // A slot whose nonce changed is a different tab reusing the id; rebuild it.
    if (wanted.get(tabId) === entry.nonce) continue;
    guests.delete(tabId);
    entry.element.remove();
  }

  for (const [tabId, nonce] of wanted) {
    if (guests.has(tabId)) continue;
    const entry = createGuest(tabId, nonce);
    guests.set(tabId, entry);
    layer.appendChild(entry.element);
    applyPlacement(tabId, entry);
  }
}

/** Called once from BrowserGuestLayer when the always-mounted host div exists. */
export function mountGuestLayer(element: HTMLDivElement): () => void {
  layer = element;
  const stopRoster = window.suocode.onBrowserGuestRoster(reconcile);
  void window.suocode.browserGuestLayerReady().then(reconcile);
  return () => {
    stopRoster();
    for (const entry of guests.values()) entry.element.remove();
    guests.clear();
    layer = undefined;
  };
}

/** BrowserPanel reports where the active tab's guest should be drawn. */
export function setGuestPlacement(next: GuestPlacement | undefined): void {
  placement = next;
  for (const [tabId, entry] of guests) applyPlacement(tabId, entry);
}
