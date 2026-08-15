import { useEffect, useRef } from "react";
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

  return <div className="browser-guest-layer" ref={hostRef} aria-hidden="true" />;
}
