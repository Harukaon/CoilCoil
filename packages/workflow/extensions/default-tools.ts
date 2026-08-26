import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  COILCOIL_ENGINEERING_STANDARDS,
  COILCOIL_WINDOWS_SHELL_STANDARDS,
} from "./system/engineering-standards.ts";

const DEFAULT_EXTRA_TOOLS = ["grep", "ls"];

/**
 * Pi's `powershell` tool throws on construction anywhere but Windows, so it is
 * activated only there. It runs commands through pwsh/Windows PowerShell
 * directly, which spares the model the Bash quoting and escaping rules that do
 * not apply on Windows.
 */
const WINDOWS_ONLY_TOOLS = ["powershell"];

const AVAILABLE_TOOLS_HEADING = "\n\nAvailable tools:\n";
const GUIDELINES_HEADING = "\n\nGuidelines:\n";
const PI_DOCUMENTATION_HEADING = "\n\nPi documentation (";
const PI_DOCUMENTATION_FOOTER =
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";

export function extraToolsForPlatform(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? [...DEFAULT_EXTRA_TOOLS, ...WINDOWS_ONLY_TOOLS] : [...DEFAULT_EXTRA_TOOLS];
}

export function coreGuidelines(platform: NodeJS.Platform = process.platform): string {
  const standards = platform === "win32"
    ? `${COILCOIL_ENGINEERING_STANDARDS}\n\n${COILCOIL_WINDOWS_SHELL_STANDARDS}`
    : COILCOIL_ENGINEERING_STANDARDS;
  return `\n\n${standards}`;
}

export function removeRedundantToolCatalog(systemPrompt: string): string {
  const start = systemPrompt.indexOf(AVAILABLE_TOOLS_HEADING);
  if (start < 0) return systemPrompt;

  const end = systemPrompt.indexOf(
    GUIDELINES_HEADING,
    start + AVAILABLE_TOOLS_HEADING.length,
  );
  if (end < 0) return systemPrompt;

  return `${systemPrompt.slice(0, start)}${systemPrompt.slice(end)}`;
}

export function removePiDocumentationGuide(systemPrompt: string): string {
  const start = systemPrompt.indexOf(PI_DOCUMENTATION_HEADING);
  if (start < 0) return systemPrompt;

  const footer = systemPrompt.indexOf(PI_DOCUMENTATION_FOOTER, start);
  if (footer < 0) return systemPrompt;

  const end = footer + PI_DOCUMENTATION_FOOTER.length;
  return `${systemPrompt.slice(0, start)}${systemPrompt.slice(end)}`;
}

export function removeToolPromptGuidelines(
  systemPrompt: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const start = systemPrompt.indexOf(GUIDELINES_HEADING);
  if (start < 0) return systemPrompt;
  const end = systemPrompt.indexOf(PI_DOCUMENTATION_HEADING, start);
  if (end < 0) return systemPrompt;
  return `${systemPrompt.slice(0, start)}${coreGuidelines(platform)}${systemPrompt.slice(end)}`;
}

export function trimNativeSystemPrompt(
  systemPrompt: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return removePiDocumentationGuide(
    removeToolPromptGuidelines(removeRedundantToolCatalog(systemPrompt), platform),
  );
}

export default function defaultToolsExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const activeTools = new Set(pi.getActiveTools());

    for (const toolName of extraToolsForPlatform()) {
      activeTools.add(toolName);
    }

    pi.setActiveTools([...activeTools]);
  });

  pi.on("before_agent_start", (event) => {
    const systemPrompt = trimNativeSystemPrompt(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
}
