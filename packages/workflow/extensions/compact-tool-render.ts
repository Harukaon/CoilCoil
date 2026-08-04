import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PATCH_STATE = Symbol.for("suocode-workflow.compact-tool-render.patch");
const PURPOSE_REGISTRY = Symbol.for("suocode-workflow.tool-purpose-registry");
const PURPOSE_FIELDS = ["purpose", "_auditPurpose", "__auditPurpose"];
const OUTPUT_TAIL_LINES = 3;

type JsonRecord = Record<string, unknown>;

interface ToolResultView {
  content: Array<{
    type: string;
    text?: string;
  }>;
  isError: boolean;
}

interface ToolExecutionView {
  toolName: string;
  toolCallId: string;
  args: unknown;
  expanded: boolean;
  executionStarted: boolean;
  isPartial: boolean;
  result?: ToolResultView;
}

interface CompactTheme {
  bold(text: string): string;
  fg(
    color: "dim" | "error" | "success" | "toolOutput" | "toolTitle",
    text: string,
  ): string;
}

interface ToolExecutionPrototype {
  render(this: ToolExecutionView, width: number): string[];
  markExecutionStarted(this: ToolExecutionView): void;
  updateResult(
    this: ToolExecutionView,
    result: ToolResultView,
    isPartial?: boolean,
  ): void;
  [PATCH_STATE]?: PatchState;
}

interface PatchState {
  originalRender: ToolExecutionPrototype["render"];
  originalMarkExecutionStarted: ToolExecutionPrototype["markExecutionStarted"];
  originalUpdateResult: ToolExecutionPrototype["updateResult"];
}

interface PurposeRecord {
  purpose: string;
  toolName: string;
  timestamp: number;
}

interface CompactLineOptions {
  toolName: string;
  toolCallId: string;
  args: unknown;
  executionStarted: boolean;
  isPartial: boolean;
  result?: ToolResultView;
  startedAt?: number;
  completedAt?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPurposeRegistry(): Map<string, PurposeRecord> | undefined {
  const registry = (globalThis as Record<PropertyKey, unknown>)[
    PURPOSE_REGISTRY
  ];
  return registry instanceof Map
    ? (registry as Map<string, PurposeRecord>)
    : undefined;
}

function getPurpose(toolCallId: string, args: unknown): string | undefined {
  const recorded = getPurposeRegistry()?.get(toolCallId)?.purpose;
  if (recorded) return recorded;
  if (!isRecord(args)) return undefined;

  for (const field of PURPOSE_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const [field, value] of Object.entries(args)) {
    if (
      field.startsWith("__auditPurpose_") &&
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return undefined;
}

function getOutputLines(result: ToolResultView | undefined): string[] {
  if (!result) return [];

  return result.content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block.text === "string" && block.text.length > 0,
    )
    .flatMap((block) =>
      stripVTControlCharacters(block.text)
        .replace(/\r/g, "\n")
        .split("\n"),
    )
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatDuration(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return undefined;
  }

  const safeMilliseconds = Math.max(0, milliseconds);
  if (safeMilliseconds < 1_000) return `${Math.round(safeMilliseconds)}ms`;
  if (safeMilliseconds < 10_000) {
    return `${(safeMilliseconds / 1_000).toFixed(1)}s`;
  }
  return `${Math.round(safeMilliseconds / 1_000)}s`;
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…");
}

export function buildCompactToolLines(
  options: CompactLineOptions,
  width: number,
  theme: CompactTheme,
): string[] {
  const purpose = getPurpose(options.toolCallId, options.args);
  const completed = options.result !== undefined && !options.isPartial;
  const failed = completed && options.result?.isError === true;
  const symbol = failed ? "✗" : completed ? "✓" : options.executionStarted ? "●" : "○";
  const symbolColor = failed ? "error" : completed ? "success" : "dim";
  const duration = completed
    ? formatDuration(
        options.startedAt === undefined || options.completedAt === undefined
          ? undefined
          : options.completedAt - options.startedAt,
      )
    : undefined;

  let heading = `${theme.fg(symbolColor, symbol)} ${theme.fg(
    "toolTitle",
    theme.bold(options.toolName),
  )}`;
  if (purpose) heading += ` ${theme.fg("dim", `· ${purpose}`)}`;
  if (duration) heading += ` ${theme.fg("dim", `· ${duration}`)}`;

  const outputLines = getOutputLines(options.result);
  if (failed && outputLines.length > 0) {
    heading += ` ${theme.fg("error", `· ${outputLines.at(-1)}`)}`;
  }

  if (completed) return [fit(heading, width)];

  const tail = outputLines.slice(-OUTPUT_TAIL_LINES).map((line) =>
    fit(
      `${theme.fg("dim", "│")} ${theme.fg("toolOutput", line)}`,
      width,
    ),
  );
  return [fit(heading, width), ...tail];
}

function findPackageRoot(startFile: string): string | undefined {
  let current = dirname(startFile);
  const filesystemRoot = parse(current).root;

  while (current !== filesystemRoot) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(current, "package.json"), "utf8"),
      ) as { name?: string };
      if (manifest.name === PACKAGE_NAME) return current;
    } catch {
      // Keep walking toward the filesystem root.
    }
    current = dirname(current);
  }

  return undefined;
}

function resolvePiPackageRoot(): string | undefined {
  const candidates: string[] = [];

  if (process.argv[1]) {
    try {
      candidates.push(realpathSync(process.argv[1]));
    } catch {
      // The current process may not have been launched through Pi's CLI.
    }
  }

  try {
    candidates.push(fileURLToPath(import.meta.resolve(PACKAGE_NAME)));
  } catch {
    // Fall through to a clean compatibility warning.
  }

  for (const candidate of candidates) {
    const root = findPackageRoot(candidate);
    if (root) return root;
  }
  return undefined;
}

function isPatchState(value: unknown): value is PatchState {
  return (
    isRecord(value) &&
    typeof value.originalRender === "function" &&
    typeof value.originalMarkExecutionStarted === "function" &&
    typeof value.originalUpdateResult === "function"
  );
}

async function installCompactRenderer(): Promise<void> {
  const packageRoot = resolvePiPackageRoot();
  if (!packageRoot) throw new Error("无法定位 Pi 安装目录");

  const componentUrl = pathToFileURL(
    join(
      packageRoot,
      "dist/modes/interactive/components/tool-execution.js",
    ),
  ).href;
  const themeUrl = pathToFileURL(
    join(packageRoot, "dist/modes/interactive/theme/theme.js"),
  ).href;

  const [{ ToolExecutionComponent }, { theme }] = await Promise.all([
    import(componentUrl) as Promise<{
      ToolExecutionComponent?: { prototype?: ToolExecutionPrototype };
    }>,
    import(themeUrl) as Promise<{ theme?: CompactTheme }>,
  ]);

  const prototype = ToolExecutionComponent?.prototype;
  if (
    !prototype ||
    !theme ||
    typeof prototype.render !== "function" ||
    typeof prototype.markExecutionStarted !== "function" ||
    typeof prototype.updateResult !== "function"
  ) {
    throw new Error("当前 Pi 版本的工具渲染结构不兼容");
  }

  const previousPatch = prototype[PATCH_STATE];
  if (isPatchState(previousPatch)) {
    prototype.render = previousPatch.originalRender;
    prototype.markExecutionStarted =
      previousPatch.originalMarkExecutionStarted;
    prototype.updateResult = previousPatch.originalUpdateResult;
  }

  const originalRender = prototype.render;
  const originalMarkExecutionStarted = prototype.markExecutionStarted;
  const originalUpdateResult = prototype.updateResult;
  const startedAt = new WeakMap<object, number>();
  const completedAt = new WeakMap<object, number>();

  prototype.markExecutionStarted = function (): void {
    startedAt.set(this, performance.now());
    originalMarkExecutionStarted.call(this);
  };

  prototype.updateResult = function (
    result: ToolResultView,
    isPartial = false,
  ): void {
    originalUpdateResult.call(this, result, isPartial);
    if (!isPartial) completedAt.set(this, performance.now());
  };

  prototype.render = function (width: number): string[] {
    if (this.expanded) return originalRender.call(this, width);

    return buildCompactToolLines(
      {
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        args: this.args,
        executionStarted: this.executionStarted,
        isPartial: this.isPartial,
        result: this.result,
        startedAt: startedAt.get(this),
        completedAt: completedAt.get(this),
      },
      width,
      theme,
    );
  };

  prototype[PATCH_STATE] = {
    originalRender,
    originalMarkExecutionStarted,
    originalUpdateResult,
  };
}

export default async function compactToolRenderExtension(
  pi: ExtensionAPI,
): Promise<void> {
  let compatibilityError: string | undefined;
  try {
    await installCompactRenderer();
  } catch (error) {
    compatibilityError = error instanceof Error ? error.message : String(error);
  }

  if (compatibilityError) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `紧凑工具渲染未启用：${compatibilityError}`,
          "warning",
        );
      }
    });
  }
}
