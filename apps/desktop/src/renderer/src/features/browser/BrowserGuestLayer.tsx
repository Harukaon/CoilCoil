import { useEffect, useRef } from "react";
import { installBrowserFocusReturn } from "./focusReturn";
import { mountGuestLayer } from "./guestLayer";

/**
 * Always-mounted host for the browser's `<webview>` guests.
 *
 * Must stay a sibling of the app shell and outside every conditional surface:
 * the inspector pane is hidden with `display:none` and the whole tree is
 * unmounted for the skills workspace, either of which would destroy every
 * agent's page. The guests themselves are managed imperatively by guestLayer.
 */
export function BrowserGuestLayer(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return mountGuestLayer(host);
  }, []);

  // Agent 在网页里点击、打字时抢走的焦点，还给用户原来所在的地方。
  useEffect(() => installBrowserFocusReturn(), []);

  return <div className="browser-guest-layer" ref={hostRef} aria-hidden="true" />;
}
