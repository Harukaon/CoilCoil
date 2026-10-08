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

const STANDARDS_TAG = "engineering_standards";

export function extraToolsForPlatform(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? [...DEFAULT_EXTRA_TOOLS, ...WINDOWS_ONLY_TOOLS] : [...DEFAULT_EXTRA_TOOLS];
}

/**
 * The engineering standards as one tagged block, shaped like the other blocks
 * CoilCoil adds to the system prompt (`<tool_audit_policy>`, the memory blocks).
 */
export function engineeringStandardsBlock(platform: NodeJS.Platform = process.platform): string {
  const standards = platform === "win32"
    ? `${COILCOIL_ENGINEERING_STANDARDS}\n\n${COILCOIL_WINDOWS_SHELL_STANDARDS}`
    : COILCOIL_ENGINEERING_STANDARDS;
  return `<${STANDARDS_TAG}>\n${standards}\n</${STANDARDS_TAG}>`;
}

/**
 * Adds the engineering standards after whatever the prompt already holds, once.
 *
 * The standards used to be spliced in by looking for Pi's own headings
 * ("Guidelines:", "Available tools:") and replacing what lay between them. When
 * Pi moved to tagged sections those headings were gone, the search found nothing
 * and quietly did nothing, so the standards stopped reaching the model while
 * every test, which fed in a hand-written prompt with the old headings, kept
 * passing. Appending needs no anchor in Pi's text that could go missing, and it
 * leaves Pi's own sections exactly as Pi wrote them.
 */
export function withEngineeringStandards(
  systemPrompt: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (systemPrompt.includes(`<${STANDARDS_TAG}>`)) return systemPrompt;
  return `${systemPrompt}\n\n${engineeringStandardsBlock(platform)}`;
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
    const systemPrompt = withEngineeringStandards(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
}
