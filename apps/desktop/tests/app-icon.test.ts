import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { appIconFilename, appIconPath, DARK_APP_ICON, LIGHT_APP_ICON } from "../src/main/app-icon.ts";

const desktopRoot = resolve(import.meta.dirname, "..");

function pngDimensions(path: string): { width: number; height: number; colorType: number } {
  const data = readFileSync(path);
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    colorType: data[25],
  };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("application icons select the supplied artwork for each system tone", () => {
  assert.equal(appIconFilename(false), LIGHT_APP_ICON);
  assert.equal(appIconFilename(true), DARK_APP_ICON);
  assert.equal(
    appIconPath({ dark: false, packaged: true, resourcesPath: "/app/resources", mainDirectory: "/app/out/main" }),
    join("/app/resources", "icons", LIGHT_APP_ICON),
  );
  assert.equal(
    appIconPath({ dark: true, packaged: false, resourcesPath: "/app/resources", mainDirectory: "/app/out/main" }),
    join("/app/out/main", "../../build", DARK_APP_ICON),
  );
});

test("packaged application icon assets are square RGBA images and the two tones differ", () => {
  const defaultIcon = join(desktopRoot, "build/icon.png");
  const lightIcon = join(desktopRoot, `build/${LIGHT_APP_ICON}`);
  const darkIcon = join(desktopRoot, `build/${DARK_APP_ICON}`);
  for (const path of [defaultIcon, lightIcon, darkIcon]) {
    assert.deepEqual(pngDimensions(path), { width: 1024, height: 1024, colorType: 6 });
  }
  assert.equal(digest(defaultIcon), digest(lightIcon), "the installer icon should use the light-tone artwork by default");
  assert.notEqual(digest(lightIcon), digest(darkIcon));
});
