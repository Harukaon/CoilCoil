#!/usr/bin/env node
// End-to-end scenarios against the real desktop app, driven by a mock model.
// Usage: npm run e2e [-- <scenario> ...]   (see README.md)
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { driver, launch, startSite } from "./harness.mjs";

const scenarioDir = join(import.meta.dirname, "scenarios");
const available = readdirSync(scenarioDir).filter((file) => file.endsWith(".mjs")).map((file) => basename(file, ".mjs")).sort();
const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !available.includes(name));
if (unknown.length) {
  console.error(`未知场景：${unknown.join(", ")}\n可用：${available.join(", ")}`);
  process.exit(2);
}
const selected = requested.length ? requested : available;
const artifacts = mkdtempSync(join(tmpdir(), "coilcoil-e2e-shots-"));
const site = await startSite();
let failures = 0;

for (const name of selected) {
  const scenario = await import(join(scenarioDir, `${name}.mjs`));
  console.log(`\n== ${name}：${scenario.description ?? ""}`);
  const results = [];
  const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
  let session;
  try {
    session = await launch(scenario.launchOptions ?? {});
    const shot = (label) => session.page.screenshot({ path: join(artifacts, `${name}-${label}.png`) });
    await scenario.run({ ...session, ui: driver(session.page), site, check, shot });
  } catch (error) {
    results.push({ label: "场景执行出错", ok: false, detail: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    await session?.page.screenshot({ path: join(artifacts, `${name}-error.png`) }).catch(() => undefined);
  } finally {
    await session?.close();
  }
  for (const result of results) {
    if (!result.ok) failures += 1;
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.label}${result.detail && !result.ok ? `  —  ${result.detail}` : ""}`);
  }
}

await site.close();
console.log(`\n截图：${artifacts}`);
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
