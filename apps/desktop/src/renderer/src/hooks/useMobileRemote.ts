import { useEffect, useState } from "react";

/** Keep in step with the breakpoint in mobile.css, which is gated the same way. */
export const MOBILE_DECK_QUERY = "(max-width: 780px)";

export function isRemoteClient(): boolean {
  return document.documentElement.dataset.client === "remote";
}

/**
 * Whether this is the phone-sized remote client.
 *
 * Both halves matter. The remote flag keeps the desktop window on its own
 * behaviour no matter how narrow someone drags it, and the width query keeps
 * the remote URL opened on a laptop from getting the phone treatment.
 */
export function useMobileRemote(): boolean {
  const [mobile, setMobile] = useState(() => (
    isRemoteClient() && window.matchMedia(MOBILE_DECK_QUERY).matches
  ));

  useEffect(() => {
    if (!isRemoteClient()) return;
    const query = window.matchMedia(MOBILE_DECK_QUERY);
    const update = (): void => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return mobile;
}
