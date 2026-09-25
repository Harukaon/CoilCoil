import { AlertCircle, ChevronRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { SyntheticEvent } from "react";
import type { ToolRun } from "@coilcoil/runtime-protocol";
import { parseFileDiffOutput, type FileDiffOutput } from "./fileDiffOutput";

export type ActivityEntry =
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolRun };

export type ActivityDisclosure = { open: boolean; detailsMounted: boolean };

/**
 * Historical groups usually stay closed forever, so their often enormous command
 * output is only built the first time the reader opens them. Closing only hides
 * the details again, which keeps nested row disclosure state across reopenings.
 */
export function toggleActivityDisclosure(current: ActivityDisclosure, open: boolean): ActivityDisclosure {
  const detailsMounted = current.detailsMounted || open;
  return current.open === open && current.detailsMounted === detailsMounted
    ? current
    : { open, detailsMounted };
}

function lineStats(tool: ToolRun): { additions: number; deletions: number } {
  const diff = parseFileDiffOutput(tool.name, tool.output);
  if (diff) return { additions: diff.additions, deletions: diff.deletions };
  const args = tool.args;
  const added = String(args.newText ?? args.new_string ?? args.content ?? "");
  const removed = String(args.oldText ?? args.old_string ?? "");
  return {
    additions: added ? added.split("\n").length : 0,
    deletions: removed ? removed.split("\n").length : 0,
  };
}

function toolSummary(tools: ToolRun[], thinkingCount: number): string {
  const edited = new Set<string>();
  let explored = 0;
  let searches = 0;
  let commands = 0;
  let other = 0;
  for (const tool of tools) {
    const path = String(tool.args.path ?? "");
    if (["edit", "write"].includes(tool.name)) edited.add(path || tool.id);
    else if (["read", "ls", "find"].includes(tool.name)) explored += 1;
    else if (tool.name === "grep") searches += 1;
    else if (["bash", "powershell", "terminal"].includes(tool.name)) commands += 1;
    else other += 1;
  }
  const parts: string[] = [];
  if (thinkingCount) parts.push(`思考了 ${thinkingCount} 次`);
  if (edited.size) parts.push(`编辑了 ${edited.size} 个文件`);
  if (explored) parts.push(`查看了 ${explored} 个文件`);
  if (searches) parts.push(`搜索 ${searches} 次`);
  if (commands) parts.push(`运行了 ${commands} 个命令`);
  if (other) parts.push(`调用了 ${other} 个工具`);
  return parts.join("，") || `调用了 ${tools.length} 个工具`;
}

function toolArgumentsText(tool: ToolRun): string {
  const args = tool.args;
  const path = String(args.path ?? args.filePath ?? "");
  if (tool.name === "bash" || tool.name === "powershell") return String(args.command ?? "");
  if (tool.name === "read") {
    const range = [args.offset !== undefined ? `offset=${String(args.offset)}` : "", args.limit !== undefined ? `limit=${String(args.limit)}` : ""].filter(Boolean).join(" · ");
    return [path, range].filter(Boolean).join("\n");
  }
  if (tool.name === "grep") return [`pattern: ${String(args.pattern ?? "")}`, path ? `path: ${path}` : "", args.glob ? `glob: ${String(args.glob)}` : ""].filter(Boolean).join("\n");
  if (tool.name === "find") return [`pattern: ${String(args.pattern ?? "")}`, path ? `path: ${path}` : ""].filter(Boolean).join("\n");
  if (tool.name === "ls") return path || ".";
  if (tool.name === "write") return [path, String(args.content ?? "")].filter(Boolean).join("\n\n");
  if (tool.name === "edit") {
    const oldText = String(args.oldText ?? args.old_string ?? "");
    const newText = String(args.newText ?? args.new_string ?? "");
    return [path, oldText ? `--- 原内容\n${oldText}` : "", newText ? `+++ 新内容\n${newText}` : ""].filter(Boolean).join("\n\n");
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function DiffView({ diff }: { diff: FileDiffOutput }): React.JSX.Element {
  return (
    <pre className="tool-diff">
      <span className="tool-diff-header">{diff.header}</span>
      {diff.lines.map((line, index) => <span key={index} className={`tool-diff-line ${line.kind}`}>{line.text}</span>)}
    </pre>
  );
}

function ToolExecutionDetails({ tool }: { tool: ToolRun }): React.JSX.Element | null {
  const diff = parseFileDiffOutput(tool.name, tool.output);
  // 有 diff 时参数只留路径：旧文本、新文本、整份写入内容都已经在 diff 里了。
  const input = diff ? diff.path : toolArgumentsText(tool).trim();
  const output = tool.output.trim();
  if (!input && !output) return null;
  return (
    <div className="tool-execution-details">
      {input ? <section><span>调用参数</span><pre>{input}</pre></section> : null}
      {diff
        ? <section><span>改动</span><DiffView diff={diff} /></section>
        : output ? <section><span>{tool.status === "failed" ? "错误" : "执行结果"}</span><pre>{output}</pre></section> : null}
    </div>
  );
}

export function ActivityGroupView({ entries }: { entries: ActivityEntry[] }): React.JSX.Element {
  const tools = entries.flatMap((entry) => entry.kind === "tool" ? [entry.tool] : []);
  const thinkingCount = entries.filter((entry) => entry.kind === "thinking").length;
  const stats = tools.reduce((total, tool) => {
    const next = lineStats(tool);
    return { additions: total.additions + next.additions, deletions: total.deletions + next.deletions };
  }, { additions: 0, deletions: 0 });
  const running = tools.some((tool) => tool.status === "running");
  // Whether this group is open belongs to the reader. Binding `open` to
  // `running` made the group pop open the moment a tool started and snap shut
  // when it finished, throwing away whatever the reader had chosen; `running`
  // is only consulted for the state the group is born in.
  const [disclosure, setDisclosure] = useState<ActivityDisclosure>({ open: running, detailsMounted: running });
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    const nextOpen = event.currentTarget.open;
    setDisclosure((current) => toggleActivityDisclosure(current, nextOpen));
  };
  return (
    // Keep className static: useActivityGroupVirtualization adds its own class
    // and style to this element, and a changing className would wipe them.
    <details className="tool-activity" open={disclosure.open} onToggle={handleToggle}>
      <summary>
        <span>{running ? "正在执行工具" : toolSummary(tools, thinkingCount)}</span>
        {stats.additions ? <b className="additions">+{stats.additions}</b> : null}
        {stats.deletions ? <b className="deletions">-{stats.deletions}</b> : null}
        <ChevronRight className="tool-chevron" size={14} />
      </summary>
      {disclosure.detailsMounted ? (
        <div className="tool-activity-list">
          {entries.map((entry) => {
            if (entry.kind === "thinking") return <details className="tool-activity-row thinking" key={entry.id}><summary><code>think</code><span>Reasoning</span></summary><pre>{entry.text}</pre></details>;
            const tool = entry.tool;
            const itemStats = lineStats(tool);
            return <details className={`tool-activity-row ${tool.status}`} key={tool.id}><summary><code>{tool.name}</code><span>{tool.label}</span>{itemStats.additions ? <b className="additions">+{itemStats.additions}</b> : null}{itemStats.deletions ? <b className="deletions">-{itemStats.deletions}</b> : null}{tool.status === "running" ? <LoaderCircle className="spin" size={13} /> : tool.status === "failed" ? <AlertCircle size={13} /> : null}</summary><ToolExecutionDetails tool={tool} /></details>;
          })}
        </div>
      ) : null}
    </details>
  );
}
