import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

test("Pi package lists only loadable extension factories", async () => {
  const packageUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(await readFile(packageUrl, "utf8")) as {
    pi?: { extensions?: string[] };
  };
  const extensions = manifest.pi?.extensions ?? [];

  assert.ok(extensions.length > 0);

  for (const path of extensions) {
    const module = await import(new URL(`../${path}`, import.meta.url).href);
    assert.equal(typeof module.default, "function", `${path} 缺少默认扩展工厂`);
  }
});

test("summary model loading supports the packaged extension loader's Pi aliases", async () => {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      "@earendil-works/pi-ai/providers/all": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/all")),
      "@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/compat")),
    },
  });
  const module = await jiti.import<typeof import("../extensions/compaction/model.ts")>(
    fileURLToPath(new URL("../extensions/compaction/model.ts", import.meta.url)),
  );
  const { getBuiltinModels } = await import("@earendil-works/pi-ai/providers/all");
  const builtin = getBuiltinModels("anthropic").find((model) => model.id === "claude-sonnet-5-5")!;
  const alias = { ...builtin, provider: "claude-personal", compat: undefined };
  assert.equal(module.nativeSummaryModel(alias, "sk-ant-oat01-offline-test").compat?.supportsMidConvoEffort, true);
});
