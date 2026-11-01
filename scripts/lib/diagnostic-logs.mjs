import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/** Standalone smoke scripts run without a TypeScript loader. Read live and archived streams. */
export function readDiagnosticEntries(directory, processName, limit = Infinity) {
  let names;
  try { names = readdirSync(directory); } catch { return []; }
  const entries = [];
  const compressedSources = new Set(names.filter((name) => name.endsWith(".gz")).map((name) => name.slice(0, -3)));
  for (const name of names) {
    if (!(name.startsWith(`${processName}-`) || name.startsWith(`${processName}.`))
      || name.includes(".errors.") || compressedSources.has(name) || !/\.jsonl(?:\.1)?(?:\.gz)?$/.test(name)) continue;
    try {
      const stored = readFileSync(join(directory, name));
      const content = (name.endsWith(".gz") ? gunzipSync(stored, { maxOutputLength: 32 * 1024 * 1024 }) : stored).toString("utf8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch { /* A crash may leave a partial last line. */ }
      }
    } catch { /* A rotation can move a live file while the smoke report is reading it. */ }
  }
  return entries.sort((a, b) => a.ts - b.ts).slice(Number.isFinite(limit) ? -limit : 0);
}
