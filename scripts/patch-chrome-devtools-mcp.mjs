#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  resolve(repositoryRoot, "node_modules/chrome-devtools-mcp"),
  resolve(repositoryRoot, "apps/desktop/node_modules/chrome-devtools-mcp"),
];
const packageRoot = candidates.find((candidate) => existsSync(resolve(candidate, "package.json")));
if (!packageRoot) throw new Error("chrome-devtools-mcp is not installed.");

const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
if (packageJson.version !== "1.7.0") {
  throw new Error(`Unsupported chrome-devtools-mcp version ${packageJson.version}; review CoilCoil compatibility patches first.`);
}

function patchFile(relativePath, replacements) {
  const path = resolve(packageRoot, relativePath);
  let source = readFileSync(path, "utf8");
  let changed = false;
  for (const { before, after, marker } of replacements) {
    if (source.includes(marker ?? after)) continue;
    const first = source.indexOf(before);
    const last = source.lastIndexOf(before);
    if (first < 0 || first !== last) {
      throw new Error(`Expected exactly one compatibility patch site in ${relativePath}.`);
    }
    source = source.slice(0, first) + after + source.slice(first + before.length);
    changed = true;
  }
  if (changed) writeFileSync(path, source);
  return changed;
}

const changedFiles = [];
const interceptionToolSource = resolve(repositoryRoot, "scripts/chrome-devtools-mcp/intercept-network-request.js");
const interceptionToolDestination = resolve(packageRoot, "build/src/tools/intercept-network-request.js");
const interceptionToolContents = readFileSync(interceptionToolSource, "utf8");
if (!existsSync(interceptionToolDestination) || readFileSync(interceptionToolDestination, "utf8") !== interceptionToolContents) {
  writeFileSync(interceptionToolDestination, interceptionToolContents);
  changedFiles.push("tools/intercept-network-request.js");
}

if (patchFile("build/src/tools/tools.js", [
  {
    before: `import * as networkTools from './network.js';`,
    after: `import * as networkTools from './network.js';\nimport * as networkInterceptionTools from './intercept-network-request.js';`,
    marker: `import * as networkInterceptionTools from './intercept-network-request.js';`,
  },
  {
    before: `            ...Object.values(networkTools),`,
    after: `            ...Object.values(networkTools),\n            ...Object.values(networkInterceptionTools),`,
    marker: `            ...Object.values(networkInterceptionTools),`,
  },
])) changedFiles.push("tools/tools.js");

if (patchFile("build/src/ToolHandler.js", [{
  before: `            const targetPage = page ?? context.getSelectedMcpPage();`,
  after: `            // COILCOIL: discovery tools must survive a stale selected page.\n            let targetPage = page;\n            if (!targetPage) {\n                try {\n                    targetPage = context.getSelectedMcpPage();\n                }\n                catch {\n                    // response.handle() refreshes the page list and selects a live fallback.\n                }\n            }`,
  marker: "COILCOIL: discovery tools must survive a stale selected page.",
}])) changedFiles.push("ToolHandler.js");

if (patchFile("build/src/tools/pages.js", [
  {
    before: `                            catch (error) {\n                                response.appendResponseLine(\`Unable to navigate in the selected page: \${error.message}.\`);\n                            }`,
    after: `                            catch (error) {\n                                throw new Error(\`NAVIGATION_FAILED: Unable to navigate in the selected page: \${error.message}.\`, { cause: error });\n                            }`,
  },
  {
    before: `                            catch (error) {\n                                response.appendResponseLine(\`Unable to navigate back in the selected page: \${error.message}.\`);\n                            }`,
    after: `                            catch (error) {\n                                throw new Error(\`NAVIGATION_FAILED: Unable to navigate back in the selected page: \${error.message}.\`, { cause: error });\n                            }`,
  },
  {
    before: `                            catch (error) {\n                                response.appendResponseLine(\`Unable to navigate forward in the selected page: \${error.message}.\`);\n                            }`,
    after: `                            catch (error) {\n                                throw new Error(\`NAVIGATION_FAILED: Unable to navigate forward in the selected page: \${error.message}.\`, { cause: error });\n                            }`,
  },
  {
    before: `                            catch (error) {\n                                response.appendResponseLine(\`Unable to reload the selected page: \${error.message}.\`);\n                            }`,
    after: `                            catch (error) {\n                                throw new Error(\`PAGE_RELOAD_FAILED: Unable to reload the selected page: \${error.message}.\`, { cause: error });\n                            }`,
  },
])) changedFiles.push("tools/pages.js");

if (patchFile("build/src/tools/snapshot.js", [{
  before: `        text: zod\n            .array(zod.string())\n            .min(1)\n            .describe('Non-empty list of texts. Resolves when any value appears on the page.'),`,
  after: `        text: zod\n            .union([zod.string(), zod.array(zod.string()).min(1)])\n            .transform(value => typeof value === 'string' ? [value] : value)\n            .describe('Text or non-empty list of texts. Resolves when any value appears on the page.'),`,
}])) changedFiles.push("tools/snapshot.js");

if (patchFile("build/src/tools/network.js", [
  {
    before: `.describe('The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.'),`,
    after: `.describe('The reqid of the network request. If omitted, returns the DevTools-selected request or the most recent request.'),`,
  },
  {
    before: `        if (request.params.reqid) {`,
    after: `        if (request.params.reqid !== undefined) {`,
  },
  {
    before: `            const reqid = data?.cdpRequestId\n                ? request.page.resolveCdpRequestId(data.cdpRequestId)\n                : undefined;`,
    after: `            const selectedReqid = data?.cdpRequestId\n                ? request.page.resolveCdpRequestId(data.cdpRequestId)\n                : undefined;\n            const latestRequest = request.page.getNetworkRequests(false).at(-1);\n            const reqid = selectedReqid ?? (latestRequest\n                ? request.page.networkCollector.getIdForResource(latestRequest)\n                : undefined);`,
  },
  {
    before: `                response.appendResponseLine(\`Nothing is currently selected in the DevTools Network panel.\`);`,
    after: `                throw new Error('NO_NETWORK_REQUEST: No network request has been recorded for the selected page.');`,
  },
])) changedFiles.push("tools/network.js");

if (patchFile("build/src/tools/performance.js", [
  {
    before: `        if (!context.isRunningPerformanceTrace()) {\n            return;\n        }`,
    after: `        if (!context.isRunningPerformanceTrace()) {\n            throw new Error('NO_ACTIVE_TRACE: No performance trace is currently being recorded.');\n        }`,
  },
  {
    before: `        if (!lastRecording) {\n            response.appendResponseLine('No recorded traces found. Record a performance trace so you have Insights to analyze.');\n            return;\n        }\n        response.attachTraceInsight(lastRecording, request.params.insightSetId, request.params.insightName);`,
    after: `        if (!lastRecording) {\n            throw new Error('NO_RECORDED_TRACE: Record a performance trace before analyzing an insight.');\n        }\n        const insightSet = lastRecording.insights?.get(request.params.insightSetId);\n        if (!insightSet) {\n            throw new Error(\`INSIGHT_SET_NOT_FOUND: No performance insight set named \${request.params.insightSetId}.\`);\n        }\n        if (!Object.prototype.hasOwnProperty.call(insightSet.model, request.params.insightName)) {\n            throw new Error(\`INSIGHT_NOT_FOUND: No \${request.params.insightName} insight exists in set \${request.params.insightSetId}.\`);\n        }\n        response.attachTraceInsight(lastRecording, request.params.insightSetId, request.params.insightName);`,
  },
])) changedFiles.push("tools/performance.js");

if (patchFile("build/src/McpResponse.js", [{
  before: `            for (const insightSet of data.traceSummary.insights?.values() ?? []) {\n                for (const [insightName, model] of Object.entries(insightSet.model)) {\n                    structuredContent.traceInsights.push({\n                        insightName,`,
  after: `            for (const [insightSetId, insightSet] of data.traceSummary.insights?.entries() ?? []) {\n                for (const [insightName, model] of Object.entries(insightSet.model)) {\n                    structuredContent.traceInsights.push({\n                        insightSetId,\n                        insightName,`,
}])) changedFiles.push("McpResponse.js");

/**
 * `pageId` is a choice, not a toll gate.
 *
 * CoilCoil runs the server with `--experimentalPageIdRouting`, which prepends a
 * `pageId` to every page-scoped tool. Upstream declares it required, so the Agent
 * — which has no way of knowing a page list exists before it has called a tool —
 * gets `Invalid arguments: Required at pageId` on its first `take_snapshot`,
 * `click` or `navigate_page` and has to discover the argument by failing.
 * `ToolHandler` already falls back to the selected page when `pageId` is absent,
 * so the requirement never bought anything: only the schema stood in the way.
 */
if (patchFile("build/src/tools/ToolDefinition.js", [{
  before: `    pageId: zod.number().describe('Targets a specific page by ID.'),`,
  after: `    // COILCOIL: omitting pageId targets the selected page, as the handler already does.\n    pageId: zod\n        .number()\n        .optional()\n        .describe('Targets a specific page by its numeric id from list_pages. Omit to act on the currently selected page.'),`,
  marker: "COILCOIL: omitting pageId targets the selected page",
}])) changedFiles.push("tools/ToolDefinition.js");

if (patchFile("build/src/tools/lighthouse.js", [{
  before: `                url: lhr.mainDocumentUrl,`,
  after: `                url: lhr.mainDocumentUrl ?? lhr.finalDisplayedUrl ?? page.pptrPage.url(),`,
}])) changedFiles.push("tools/lighthouse.js");

process.stdout.write(changedFiles.length
  ? `Patched chrome-devtools-mcp 1.7.0: ${changedFiles.join(", ")}\n`
  : "chrome-devtools-mcp 1.7.0 compatibility patches already applied.\n");
