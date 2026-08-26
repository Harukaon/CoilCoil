import type { WebContents } from "electron";

/** Wide enough to read a page on a phone, small enough to push every second. */
const DEFAULT_MAX_WIDTH = 900;

/** JPEG quality: text stays legible, a frame stays well under a hundred KB. */
const QUALITY = 70;

/**
 * A picture of what a browser guest is showing right now.
 *
 * A phone cannot host the `<webview>` the desktop window renders a page into,
 * but the page itself is live on the Mac and the agent is driving it. The
 * remote browser panel watches frames of it rather than embedding a browser of
 * its own, which is why this exists at all.
 */
export async function captureGuestFrame(
  guest: WebContents | undefined,
  maxWidth = DEFAULT_MAX_WIDTH,
): Promise<string | undefined> {
  if (!guest || guest.isDestroyed()) return undefined;
  const image = await guest.capturePage();
  if (image.isEmpty()) return undefined;
  const { width } = image.getSize();
  const scaled = width > maxWidth ? image.resize({ width: maxWidth }) : image;
  return `data:image/jpeg;base64,${scaled.toJPEG(QUALITY).toString("base64")}`;
}
