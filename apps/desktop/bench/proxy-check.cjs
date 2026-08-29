const { app, session } = require("electron");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
app.setPath("userData", mkdtempSync(join(tmpdir(), "coilcoil-proxy-")));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

app.whenReady().then(async () => {
  app.dock?.hide();
  const targets = ["https://www.wikipedia.org/", "https://example.com/", "https://www.google.com/", "http://127.0.0.1/"];
  for (const [label, store] of [["默认 session", session.defaultSession], ["浏览器分区", session.fromPartition("persist:coilcoil-browser")]]) {
    for (const target of targets) {
      const t0 = now();
      const rules = await store.resolveProxy(target);
      console.log(`${label.padEnd(12)} ${target.padEnd(28)} -> ${rules}   (${(now() - t0).toFixed(0)}ms)`);
    }
  }
  app.exit(0);
});
