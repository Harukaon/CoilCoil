import {
  existsSync,
  readFileSync,
} from "node:fs";
import {
  dirname,
  join,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";
import { require } from "./runtime-constants.js";

export function resolvePackageDirectory(packageName: string): string {
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    let entryPath: string;
    try {
      entryPath = require.resolve(packageName);
    } catch {
      entryPath = fileURLToPath(import.meta.resolve(packageName));
    }

    let directory = dirname(entryPath);
    while (directory !== dirname(directory)) {
      const manifestPath = join(directory, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; };
        if (manifest.name === packageName) return directory;
      }
      directory = dirname(directory);
    }
  }

  throw new Error(`Unable to resolve bundled package: ${packageName}`);
}
