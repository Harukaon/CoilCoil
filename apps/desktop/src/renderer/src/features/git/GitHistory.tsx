import { ChevronDown, ChevronRight, CircleDot, Cloud, GitBranch, GitFork, LoaderCircle, RefreshCw, Tag } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitCommit, GitCommitFile, GitCommitRef, GitLog, GitStatus } from "@coilcoil/runtime-protocol";
import { FileRow } from "./GitFileRow";
import { buildGraph, graphShape, GRAPH_ROW_HEIGHT, placeholderShape, refColors, type GraphShape } from "./gitGraph";

const PAGE_SIZE = 50;
const OPEN_KEY = "coilcoil.git.historyOpen";
const ALL_KEY = "coilcoil.git.historyAll";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try { window.localStorage.setItem(key, value ? "1" : "0"); } catch { /* 记不住就算了 */ }
}

export function relativeTime(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.round(months / 12)} 年前`;
}

function commitTooltip(commit: GitCommit): string {
  return [
    commit.subject,
    commit.body,
    `${commit.author} <${commit.email}>`,
    new Date(commit.date).toLocaleString(),
    commit.hash,
  ].filter(Boolean).join("\n\n");
}

function Graph({ shape }: { shape: Pick<GraphShape, "width" | "paths"> & { circle?: GraphShape["circle"] } }): React.JSX.Element {
  const circle = shape.circle;
  return (
    <svg className="git-graph" width={shape.width} height={GRAPH_ROW_HEIGHT} aria-hidden="true">
      {shape.paths.map((path, index) => <path key={index} d={path.d} stroke={path.color} />)}
      {circle?.kind === "head" ? (
        <>
          <circle cx={circle.cx} cy={circle.cy} r={6} fill={circle.color} />
          <circle className="git-graph-hole" cx={circle.cx} cy={circle.cy} r={2} />
        </>
      ) : circle?.kind === "merge" ? (
        <>
          <circle cx={circle.cx} cy={circle.cy} r={6} fill={circle.color} />
          <circle cx={circle.cx} cy={circle.cy} r={3} fill={circle.color} />
        </>
      ) : circle ? <circle cx={circle.cx} cy={circle.cy} r={5} fill={circle.color} /> : null}
    </svg>
  );
}

const REF_ICON = { branch: GitBranch, remote: Cloud, tag: Tag, head: CircleDot } as const;

function RefBadge({ gitRef, color }: { gitRef: GitCommitRef; color?: string }): React.JSX.Element {
  const Icon = REF_ICON[gitRef.kind];
  return (
    <span className={`git-ref ${color ? "colored" : ""}`} style={color ? { background: color } : undefined} title={gitRef.fullName}>
      <Icon size={10} />
      <span>{gitRef.name}</span>
    </span>
  );
}

/**
 * 「更改」下面那个可折叠的提交历史，和 VS Code 源代码管理里的「图形」一样：左边一列
 * 线条画出分支怎么分叉、怎么合并，点一个提交展开它改了的文件，再点文件看 diff。
 *
 * 默认只看当前分支和它的上游（和 VS Code 默认一致），可以切到所有分支。HEAD、领先
 * 落后一变就重读一次，所以提交、拉取、切分支之后图马上跟着变。
 */
export function GitHistory({ status, log, commitFiles, onOpenFile }: {
  status?: GitStatus;
  log: (limit: number, all: boolean) => Promise<GitLog>;
  commitFiles: (hash: string) => Promise<GitCommitFile[]>;
  onOpenFile: (commit: GitCommit, file: GitCommitFile) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(() => readFlag(OPEN_KEY, true));
  const [all, setAll] = useState(() => readFlag(ALL_KEY, false));
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [history, setHistory] = useState<GitLog>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [files, setFiles] = useState<Record<string, GitCommitFile[] | string>>({});
  const [reloadToken, setReloadToken] = useState(0);
  const requestId = useRef(0);

  const repository = Boolean(status?.repository);
  const unborn = status?.unborn === true;
  // 这几个一变，图就可能变：新提交、拉取、推送、切分支、上游变了。
  const changeKey = `${status?.root}|${status?.head}|${status?.branch}|${status?.upstream}|${status?.ahead}|${status?.behind}`;

  useEffect(() => {
    if (!open || !repository || unborn) return;
    const id = ++requestId.current;
    setLoading(true);
    log(limit, all).then((next) => {
      if (id !== requestId.current) return;
      setHistory(next);
      setError(undefined);
    }, (caught: unknown) => {
      if (id === requestId.current) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (id === requestId.current) setLoading(false);
    });
  }, [all, changeKey, limit, log, open, reloadToken, repository, unborn]);

  const rows = useMemo(() => (history ? buildGraph(history.commits, history) : []), [history]);
  const colors = useMemo(() => refColors(history ?? {}), [history]);

  const toggleCommit = useCallback((hash: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
    if (files[hash] === undefined) {
      commitFiles(hash).then(
        (list) => setFiles((current) => ({ ...current, [hash]: list })),
        (caught: unknown) => setFiles((current) => ({ ...current, [hash]: caught instanceof Error ? caught.message : String(caught) })),
      );
    }
  }, [commitFiles, files]);

  const toggleOpen = (): void => {
    setOpen((value) => {
      writeFlag(OPEN_KEY, !value);
      return !value;
    });
  };
  const toggleAll = (): void => {
    const next = !all;
    writeFlag(ALL_KEY, next);
    setAll(next);
    setLimit(PAGE_SIZE);
  };

  return (
    <section className="git-section git-history">
      <header>
        <button className="git-section-toggle" type="button" aria-expanded={open} onClick={toggleOpen}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>提交历史</span>
          {loading ? <LoaderCircle size={11} className="spin" /> : null}
        </button>
        {open ? (
          <>
            <button className="git-icon-button" type="button" aria-label="显示所有分支" aria-pressed={all} title={all ? "正在显示所有分支，点一下只看当前分支" : "只显示当前分支和它的上游，点一下显示所有分支"} onClick={toggleAll}>
              <GitFork size={13} />
            </button>
            <button className="git-icon-button" type="button" aria-label="刷新提交历史" onClick={() => setReloadToken((value) => value + 1)}><RefreshCw size={12} /></button>
          </>
        ) : null}
      </header>
      {open ? (
        <>
          {error ? <div className="git-error">{error}</div> : null}
          {unborn ? <div className="git-empty">还没有任何提交。</div> : null}
          <ul className="git-commits">
            {rows.map((row) => {
              const { commit } = row;
              const isOpen = expanded.has(commit.hash);
              const commitFileList = files[commit.hash];
              return (
                <li key={commit.hash} className={`git-commit-item ${row.head ? "head" : ""}`}>
                  <button className="git-commit-line" type="button" aria-expanded={isOpen} title={commitTooltip(commit)} onClick={() => toggleCommit(commit.hash)}>
                    <Graph shape={graphShape(row)} />
                    <span className="git-commit-subject">{commit.subject}</span>
                    <span className="git-commit-meta">{commit.author} · {relativeTime(commit.date)}</span>
                    {commit.refs.length ? (
                      <span className="git-refs">
                        {commit.refs.map((ref) => <RefBadge key={ref.fullName} gitRef={ref} color={colors.get(ref.fullName)} />)}
                      </span>
                    ) : null}
                  </button>
                  {isOpen ? (
                    <ul className="git-commit-files">
                      {commitFileList === undefined ? (
                        <li className="git-commit-files-note"><Graph shape={placeholderShape(row.output)} /><LoaderCircle size={12} className="spin" /></li>
                      ) : typeof commitFileList === "string" ? (
                        <li className="git-commit-files-note"><Graph shape={placeholderShape(row.output)} />{commitFileList}</li>
                      ) : commitFileList.length === 0 ? (
                        <li className="git-commit-files-note"><Graph shape={placeholderShape(row.output)} />这个提交没有改动文件。</li>
                      ) : commitFileList.map((file) => (
                        <FileRow
                          key={file.path}
                          file={file}
                          state={file.state}
                          leading={<Graph shape={placeholderShape(row.output)} />}
                          onOpen={() => onOpenFile(commit, file)}
                        />
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {history?.hasMore ? (
            <button className="git-load-more" type="button" disabled={loading} onClick={() => setLimit((value) => value + PAGE_SIZE)}>加载更多提交</button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
