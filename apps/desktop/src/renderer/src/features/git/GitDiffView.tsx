import { ArrowLeft, Columns2, LoaderCircle, Rows3 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { GitDiff } from "@coilcoil/runtime-protocol";
import { diffStats, parseUnifiedDiff, splitRows, type DiffLine } from "./gitDiff";

const DIFF_MODE_KEY = "coilcoil.git.diffMode";

function readDiffMode(): "unified" | "split" {
  try {
    return window.localStorage.getItem(DIFF_MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function LineNumber({ value }: { value?: number }): React.JSX.Element {
  return <span className="git-diff-number">{value ?? ""}</span>;
}

function DiffCell({ line }: { line?: DiffLine }): React.JSX.Element {
  if (!line) return <><span className="git-diff-number" /><span className="git-diff-text empty" /></>;
  return (
    <>
      <LineNumber value={line.kind === "add" ? line.newNumber : line.oldNumber ?? line.newNumber} />
      <span className={`git-diff-text ${line.kind}`}>{line.text || " "}</span>
    </>
  );
}

/**
 * 一个文件的 diff。`load` 决定看的是哪份：工作区、暂存区，还是某个历史提交里的。
 * 调用方要保证 `load` 在同一份 diff 期间不变，换了就重新读。
 */
export function DiffView({ load, path, label, onBack }: {
  load: () => Promise<GitDiff>;
  path: string;
  /** 标题下面那行小字的前半截：「已暂存」「工作区」「a1b2c3d 修复登录」。 */
  label: string;
  onBack: () => void;
}): React.JSX.Element {
  const [diff, setDiff] = useState<GitDiff>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState(readDiffMode);
  useEffect(() => {
    let cancelled = false;
    setDiff(undefined);
    setError(undefined);
    load().then((next) => { if (!cancelled) setDiff(next); }, (caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { cancelled = true; };
  }, [load]);
  const hunks = useMemo(() => (diff ? parseUnifiedDiff(diff.patch) : []), [diff]);
  const stats = diffStats(hunks);
  const switchMode = (next: "unified" | "split"): void => {
    setMode(next);
    try { window.localStorage.setItem(DIFF_MODE_KEY, next); } catch { /* 记不住就算了 */ }
  };
  return (
    <div className="git-diff-view">
      <div className="git-diff-head">
        <button className="git-icon-button" type="button" aria-label="返回改动列表" onClick={onBack}><ArrowLeft size={14} /></button>
        <span className="git-diff-title" title={path}>
          <strong>{path.slice(path.lastIndexOf("/") + 1)}</strong>
          <small>{label}{hunks.length ? ` · +${stats.additions} -${stats.deletions}` : ""}</small>
        </span>
        <span className="git-segmented" role="group" aria-label="diff 显示方式">
          <button type="button" aria-pressed={mode === "unified"} aria-label="单栏" onClick={() => switchMode("unified")}><Rows3 size={13} /></button>
          <button type="button" aria-pressed={mode === "split"} aria-label="左右对照" onClick={() => switchMode("split")}><Columns2 size={13} /></button>
        </span>
      </div>
      {error ? <div className="git-error">{error}</div> : null}
      {!diff && !error ? <div className="git-empty"><LoaderCircle size={14} className="spin" />正在读取 diff…</div> : null}
      {diff?.binary ? <div className="git-empty">二进制文件，没法显示 diff。</div> : null}
      {diff && !diff.binary && hunks.length === 0 ? <div className="git-empty">没有可以显示的改动。</div> : null}
      {hunks.length ? (
        <div className={`git-diff-body ${mode}`}>
          {hunks.map((hunk, index) => (
            <Fragment key={index}>
              <div className="git-diff-hunk">{hunk.header}</div>
              {mode === "unified"
                ? hunk.lines.map((line, lineIndex) => (
                  <div className={`git-diff-row ${line.kind}`} key={lineIndex}>
                    <LineNumber value={line.oldNumber} />
                    <LineNumber value={line.newNumber} />
                    <span className={`git-diff-text ${line.kind}`}>{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}{line.text}</span>
                  </div>
                ))
                : splitRows(hunk).map((row, rowIndex) => (
                  <div className="git-diff-row split" key={rowIndex}>
                    <DiffCell line={row.left} />
                    <DiffCell line={row.right} />
                  </div>
                ))}
            </Fragment>
          ))}
          {diff?.truncated ? <div className="git-empty">diff 太大，只显示了前一部分。</div> : null}
        </div>
      ) : null}
    </div>
  );
}
