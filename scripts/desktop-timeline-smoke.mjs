/**
 * Geometry the timeline promises, checked against the real packaged renderer.
 *
 * These are all rules that unit tests cannot see: they live in styles.css and
 * only mean something once Chromium has laid the elements out. The smoke runs
 * the packaged app against a throwaway `--user-data-dir`, so it never touches an
 * installed SuoCode or the user's sessions.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const appBinary = join(repositoryRoot, "apps/desktop/release/mac-arm64/SuoCode.app/Contents/MacOS/SuoCode");

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createServer();
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  await new Promise((closed) => server.close(closed));
  if (typeof address !== "object" || !address?.port) throw new Error("Unable to reserve a DevTools port.");
  return address.port;
}

async function waitForPage(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page" && item.title === "SuoCode");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron is still starting.
    }
    await delay(100);
  }
  throw new Error("SuoCode did not expose its renderer in time.");
}

class DevToolsClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((opened, reject) => {
      this.socket.addEventListener("open", opened, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("DevTools WebSocket failed.")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await this.send("Runtime.enable");
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || "Renderer evaluation failed.");
    }
    return response.result.value;
  }

  async waitFor(expression, message, timeout = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (await this.evaluate(`(() => { try { return (${expression}); } catch { return false; } })()`)) return;
      await delay(100);
    }
    throw new Error(message);
  }

  moveMouse(x, y) {
    return this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  }

  close() {
    this.socket.close();
  }
}

const ARROW_UP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg>`;
const CLOSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`;

/**
 * Mount a fragment inside the live renderer so the app's own stylesheet applies,
 * measure it, and take it back out.
 */
function probe(html, measure) {
  return `(() => {
    const host = document.createElement("div");
    host.id = "timeline-smoke-host";
    host.style.cssText = "position:fixed;left:0;top:0;width:700px;z-index:99999;";
    host.innerHTML = ${JSON.stringify(html)};
    document.body.appendChild(host);
    return (async () => {
      try {
        // Measuring before the images decode reports them as zero-height.
        await Promise.all([...host.querySelectorAll("img")].map((image) => image.decode().catch(() => undefined)));
        return (${measure})(host);
      } finally {
        host.remove();
      }
    })();
  })()`;
}

const bubble = (text, extra = "") =>
  `<article class="timeline-message user-message"><button class="user-bubble user-bubble-button"><span class="user-bubble-text">${text}</span>${extra}</button></article>`;

// A 300x300 grey square, so the aspect ratio is obvious if anything crops it.
const TALL_IMAGE = `<span class="message-images"><span class="message-image"><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMDAiIGhlaWdodD0iMzAwIj48cmVjdCB3aWR0aD0iMzAwIiBoZWlnaHQ9IjMwMCIgZmlsbD0iIzk5OSIvPjwvc3ZnPg=="></span></span>`;

async function checkUserBubble(client) {
  const result = await client.evaluate(probe(
    `${bubble("只有一行")}${bubble(Array.from({ length: 5 }, (_, i) => `第${i + 1}行`).join("\n"))}${bubble(Array.from({ length: 40 }, (_, i) => `第${i + 1}行内容`).join("\n"))}${bubble("一行字加一张图", TALL_IMAGE)}`,
    `(host) => [...host.querySelectorAll(".user-bubble")].map((node) => {
      const image = node.querySelector(".message-image img");
      return {
        height: Number(node.getBoundingClientRect().height.toFixed(1)),
        clipped: node.scrollHeight > Math.ceil(node.getBoundingClientRect().height),
        clampedLines: Number(getComputedStyle(node.querySelector(".user-bubble-text")).webkitLineClamp),
        imageFit: image ? getComputedStyle(image).objectFit : undefined,
        imageRatio: image ? Number((image.getBoundingClientRect().width / image.getBoundingClientRect().height).toFixed(2)) : undefined,
      };
    })`,
  ));
  const [short, exact, long, withImage] = result;
  assert.ok(short.height < 60, `A one-line prompt should stay small (was ${short.height}px).`);
  for (const [name, item] of [["five-line", exact], ["forty-line", long]]) {
    assert.ok(item.height <= 142, `${name} bubble exceeded the 142px cap (${item.height}px).`);
  }
  // A hard crop would leave the 40-line bubble taller than the 5-line one; the
  // line clamp is what turns the overflow into a real ellipsis instead.
  assert.equal(long.height, exact.height, "A long prompt did not clamp to the same box as a full-height one.");
  assert.equal(long.clampedLines, 5, "The prompt bubble lost its line clamp.");
  // The cap is on the text, not on the bubble: an attached image is shown whole
  // and scaled to its own proportions, never cropped to fit a height budget.
  assert.equal(withImage.clipped, false, "An attached image was clipped by the bubble.");
  assert.ok(withImage.height > 142, `The image bubble should be free to grow (was ${withImage.height}px).`);
  assert.equal(withImage.imageFit, "contain", "Message images must scale down rather than crop.");
  assert.equal(withImage.imageRatio, 1, `A square image rendered at ratio ${withImage.imageRatio}.`);
  return { shortHeight: short.height, clampedHeight: long.height, imageHeight: withImage.height };
}

async function checkQueueRowIcons(client) {
  const offsets = await client.evaluate(probe(
    `<ol class="composer-queue-list"><li><span class="composer-queue-index">1</span><span class="composer-queue-text">1111</span><button type="button">${ARROW_UP_SVG}</button><button type="button">${CLOSE_SVG}</button></li></ol>`,
    `(host) => [...host.querySelectorAll("li button")].map((node) => {
      const button = node.getBoundingClientRect();
      const icon = node.querySelector("svg").getBoundingClientRect();
      return {
        dx: Number((icon.x + icon.width / 2 - (button.x + button.width / 2)).toFixed(2)),
        dy: Number((icon.y + icon.height / 2 - (button.y + button.height / 2)).toFixed(2)),
      };
    })`,
  ));
  assert.equal(offsets.length, 2, "The queue row lost one of its action buttons.");
  for (const [index, offset] of offsets.entries()) {
    // The buttons used to inherit the UA's `padding: 1px 6px`, which pushed the
    // 12px icon 3px right of its own hover box.
    assert.ok(Math.abs(offset.dx) <= 0.5, `Queue button ${index} icon is off-centre horizontally by ${offset.dx}px.`);
    assert.ok(Math.abs(offset.dy) <= 0.5, `Queue button ${index} icon is off-centre vertically by ${offset.dy}px.`);
  }
  return offsets;
}

async function checkAnchorRail(client) {
  // Positioning is Radix Popover's job now — it portals out of the conversation
  // pane (which is overflow:hidden and used to crop the panel) and keeps itself
  // on screen. What stays checkable here is the resting trigger and the panel's
  // own box: it must not be positioned from its own height, or adding a row
  // moves it, which is what made it jump.
  const rows = Array.from({ length: 40 }, (_, index) =>
    `<li><button class="prompt-anchor-row" type="button">第 ${index + 1} 条提示词</button></li>`).join("");
  const result = await client.evaluate(probe(
    `<nav class="prompt-anchor-rail"><button class="prompt-anchor-marks" type="button"><i></i><i></i><i></i></button></nav>`
    + `<div class="prompt-anchor-card" data-state="open"><ol>${rows}</ol></div>`
    + `<div class="prompt-anchor-card" id="anchor-card-static"><ol>${rows}</ol></div>`,
    `(host) => {
      const marks = host.querySelector(".prompt-anchor-marks");
      const dot = marks.querySelector("i");
      const dotBox = dot.getBoundingClientRect();
      const card = host.querySelector(".prompt-anchor-card");
      const cardBox = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return {
        markCount: marks.querySelectorAll("i").length,
        triggerCount: host.querySelectorAll(".prompt-anchor-rail button").length,
        dotRound: Math.abs(dotBox.width - dotBox.height) < 0.5 && getComputedStyle(dot).borderRadius === "50%",
        width: Number(cardBox.width.toFixed(1)),
        height: Number(cardBox.height.toFixed(1)),
        rows: card.querySelectorAll(".prompt-anchor-row").length,
        scrolls: card.scrollHeight > card.clientHeight + 1,
        animation: style.animationName,
        // Measured on a card with no data-state, so no animation is running and
        // the computed transform reflects only the static rules. A translate here
        // is the height-dependent centring that moved the panel as rows arrived.
        staticTransform: getComputedStyle(host.querySelector("#anchor-card-static")).transform,
      };
    }`,
  ));
  assert.equal(result.markCount, 3, "The resting rail should show three dots.");
  assert.equal(result.triggerCount, 1, "The rail should be a single button, not one per dot.");
  assert.equal(result.dotRound, true, "The rail marks should be round dots.");
  assert.equal(result.rows, 40, "The anchor panel did not list every prompt.");
  assert.ok(result.width <= 264, `The anchor panel grew past its cap (${result.width}px).`);
  assert.ok(result.height <= 320, `The anchor panel grew past its height cap (${result.height}px).`);
  assert.ok(result.scrolls, "The anchor panel cannot scroll when the list grows.");
  assert.equal(result.animation, "prompt-anchor-panel-in", "The anchor panel lost its open animation.");
  assert.equal(result.staticTransform, "none", "The panel must not place itself from its own height.");
  return result;
}

async function main() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "suocode-timeline-data-"));
  const port = await freePort();
  const child = spawn(appBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${dataDirectory}`], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  let client;
  try {
    const page = await waitForPage(port);
    client = new DevToolsClient(page.webSocketDebuggerUrl);
    await client.open();
    await client.waitFor(`document.readyState === "complete" && typeof window.suocode === "object"`, "Renderer did not become ready.");
    await client.waitFor(`Boolean(document.querySelector('textarea[aria-label="发送消息给 SuoCode"]'))`, "Composer did not render.", 45_000);

    const bubbleResult = await checkUserBubble(client);
    const iconResult = await checkQueueRowIcons(client);
    const railResult = await checkAnchorRail(client);

    console.log("desktop timeline smoke passed");
    console.log(`  user bubble: one line ${bubbleResult.shortHeight}px, long text clamps to ${bubbleResult.clampedHeight}px, image bubble grows to ${bubbleResult.imageHeight}px uncropped`);
    console.log(`  queue icons: offsets ${iconResult.map((item) => `${item.dx}/${item.dy}`).join(", ")} px from centre`);
    console.log(`  anchor rail: 3 dots / 1 button at rest; panel ${railResult.width}x${railResult.height}px, ${railResult.rows} rows, scrolls, no self-positioning`);
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await delay(500);
    if (!child.killed) child.kill("SIGKILL");
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

await main();
