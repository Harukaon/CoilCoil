import type {
  SummarizationModelConfiguration,
  SummarizationModelConfigurationInput,
} from "@coilcoil/runtime-protocol";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
} from "node:path";

/**
 * Which model writes the summaries.
 *
 * Compaction is a second conversation nobody sees: it fires on its own, it
 * sends most of the session, and on a long day it does so again and again —
 * all on whatever model the user picked for the *conversation*. Running the
 * expensive model twice over, once to think and once to summarize what it
 * thought, is the part that surprised people looking at a bill.
 *
 * Empty means "the session's own model", which is Pi's behaviour and stays the
 * default: this is an opt-in, not a second thing to configure before the app
 * works.
 */

const MAX_REFERENCE_CHARS = 200;

function settingsPath(agentDir: string): string {
  return join(agentDir, "summarization-model.json");
}

export function normalizeSummarizationModelConfiguration(value: unknown): SummarizationModelConfiguration {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return { model: typeof record.model === "string" ? record.model.trim().slice(0, MAX_REFERENCE_CHARS) : "" };
}

export function readSummarizationModelConfiguration(agentDir: string): SummarizationModelConfiguration {
  const path = settingsPath(agentDir);
  if (!existsSync(path)) return normalizeSummarizationModelConfiguration(undefined);
  try {
    return normalizeSummarizationModelConfiguration(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // 配置文件坏了就当没配：总结继续跑在会话模型上，比让压缩整个停摆强。
    return normalizeSummarizationModelConfiguration(undefined);
  }
}

export function writeSummarizationModelConfiguration(
  agentDir: string,
  input: SummarizationModelConfigurationInput,
): SummarizationModelConfiguration {
  if (!input || typeof input !== "object" || typeof input.model !== "string") {
    throw new Error("总结模型配置无效。");
  }
  const configuration = normalizeSummarizationModelConfiguration(input);
  const path = settingsPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
  return configuration;
}

/**
 * Split `provider/model-id` the way the rest of CoilCoil writes a model down.
 *
 * Only the first slash separates the two: model ids carry slashes of their own
 * (`anthropic/claude-sonnet-4` on a gateway), and splitting on all of them
 * would quietly resolve to nothing.
 */
export function parseModelReference(reference: string): { provider: string; id: string } | undefined {
  const trimmed = reference.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, separator), id: trimmed.slice(separator + 1) };
}
