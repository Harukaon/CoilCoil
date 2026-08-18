import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SOURCE_LINES = 600;
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = join(packageDirectory, "src");

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

function lineCount(source) {
  if (!source) return 0;
  return source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

const violations = [];
for (const path of await collectSourceFiles(sourceDirectory)) {
  const lines = lineCount(await readFile(path, "utf8"));
  if (lines > MAX_SOURCE_LINES) {
    violations.push(`${path.slice(packageDirectory.length + 1)}: ${lines} lines`);
  }
}

if (violations.length) {
  console.error(`runtime-core source files must stay at or below ${MAX_SOURCE_LINES} lines:`);
  for (const violation of violations.sort()) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`runtime-core architecture check passed (maximum ${MAX_SOURCE_LINES} lines per source file).`);
}
