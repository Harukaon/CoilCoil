import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const BASH_CWD_MARKER = Symbol.for("suocode-workflow.bash-cwd-schema");
const BASH_CWD_DESCRIPTION =
  "Optional working directory for this command (relative to the project root or absolute)";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSchemaMarker(schema: JsonRecord): boolean {
  return (
    (schema as JsonRecord & { [BASH_CWD_MARKER]?: unknown })[
      BASH_CWD_MARKER
    ] === true
  );
}

function markSchema(schema: JsonRecord): void {
  Object.defineProperty(schema, BASH_CWD_MARKER, {
    configurable: true,
    enumerable: false,
    value: true,
  });
}

function patchBashSchema(pi: ExtensionAPI): void {
  const bash = pi.getAllTools().find((tool) => tool.name === "bash");
  const schema = bash?.parameters;
  if (!isRecord(schema) || hasSchemaMarker(schema)) return;

  const properties = schema.properties;
  if (properties !== undefined && !isRecord(properties)) return;

  const existingCwd = isRecord(properties) ? properties.cwd : undefined;
  if (
    existingCwd !== undefined &&
    (!isRecord(existingCwd) ||
      existingCwd.description !== BASH_CWD_DESCRIPTION)
  ) {
    return;
  }

  schema.properties = {
    ...(isRecord(properties) ? properties : {}),
    cwd: {
      type: "string",
      description: BASH_CWD_DESCRIPTION,
    },
  };
  markSchema(schema);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function resolveBashCwd(rawCwd: string, baseCwd: string): string {
  const normalized = rawCwd.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("cwd 必须是非空、单行路径");
  }

  const withHome = normalized === "~"
    ? homedir()
    : normalized.startsWith("~/")
      ? `${homedir()}/${normalized.slice(2)}`
      : normalized;
  return isAbsolute(withHome) ? resolve(withHome) : resolve(baseCwd, withHome);
}

async function ensureDirectory(path: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new Error(`cwd 不存在：${path}`);
  }
  if (!details.isDirectory()) throw new Error(`cwd 不是目录：${path}`);
}

export default function bashCwdExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => patchBashSchema(pi));
  pi.on("turn_start", () => patchBashSchema(pi));
  pi.on("before_agent_start", () => patchBashSchema(pi));
  pi.on("before_provider_request", () => patchBashSchema(pi));

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const input = event.input as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(input, "cwd")) return;
    if (typeof input.cwd !== "string") {
      return {
        block: true,
        reason: "bash 的 cwd 必须是路径字符串。",
      };
    }

    let cwd: string;
    try {
      cwd = resolveBashCwd(input.cwd, ctx.cwd);
      await ensureDirectory(cwd);
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const command = typeof input.command === "string" ? input.command : "";
    input.command = `cd -- ${shellQuote(cwd)} && ${command}`;
    delete input.cwd;
  });
}
