import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, Columns2, GitBranch, LoaderCircle, Minus, Plus, RefreshCw, Rows3, Undo2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranch as GitBranchInfo, GitDiff, GitFileChange, GitFileState } from "@coilcoil/runtime-protocol";
import { ConfirmDialog } from "../../ui/dialog";
import { toastSuccess } from "../../ui/toast";
import { diffStats, parseUnifiedDiff, splitRows, type DiffLine } from "./gitDiff";
import { useGit } from "./useGit";
import "./git.css";

const DIFF_MODE_KEY = "coilcoil.git.diffMode";

const STATE_LETTER: Record<GitFileState, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", "type-changed": "T", untracked: "U", conflicted: "!",
};

const STATE_LABEL: Record<GitFileState, string> = {
  modified: "已修改", added: "新增", deleted: "已删除", renamed: "改名", copied: "复制", "type-changed": "类型变化", untracked: "未跟踪", conflicted: "冲突",
};

function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { name: path, dir: "" } : { name: path.slice(index + 1), dir: path.slice(0, index) };
}

function readDiffMode(): "unified" | "split" {
  try {
    return window.localStorage.getItem(DIFF_MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function FileRow({ file, state, onOpen, actions }: {
  file: GitFileChange;
  state: GitFileState;
  onOpen: () => void;
  actions: React.ReactNode;
}): React.JSX.Element {
  const { name, dir } = splitPath(file.path);
  return (
    <li className={`git-file state-${state}`}>
      <button className="git-file-open" type="button" onClick={onOpen} title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}>
        <span className="git-file-name">{name}</span>
        {dir ? <span className="git-file-dir">{dir}</span> : null}
      </button>
      <span className="git-file-actions">{actions}</span>
      <span className="git-file-state" title={STATE_LABEL[state]}>{STATE_LETTER[state]}</span>
    </li>
  );
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

function DiffView({ load, path, staged, onBack }: {
  load: (path: string, staged: boolean) => Promise<GitDiff>;
  path: string;
  staged: boolean;
  onBack: () => void;
}): React.JSX.Element {
  const [diff, setDiff] = useState<GitDiff>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState(readDiffMode);
  useEffect(() => {
    let cancelled = false;
    setDiff(undefined);
    setError(undefined);
    load(path, staged).then((next) => { if (!cancelled) setDiff(next); }, (caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { cancelled = true; };
  }, [load, path, staged]);
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
          <strong>{splitPath(path).name}</strong>
          <small>{staged ? "已暂存" : "工作区"}{hunks.length ? ` · +${stats.additions} -${stats.deletions}` : ""}</small>
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

function BranchMenu({ current, load, onCheckout, onCreate, disabled }: {
  current?: string;
  load: () => Promise<GitBranchInfo[]>;
  onCheckout: (branch: string) => void;
  onCreate: (name: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<GitBranchInfo[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!open) return;
    void load().then(setList, () => setList([]));
  }, [load, open]);
  return (
    <div className="git-branch">
      <button className="git-branch-button" type="button" aria-label="切换分支" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)}>
        <GitBranch size={13} />
        <span>{current ?? "分离 HEAD"}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="git-branch-menu" role="menu">
          {list.map((branch) => (
            <button key={branch.name} type="button" role="menuitem" className={branch.current ? "current" : ""} onClick={() => {
              setOpen(false);
              if (!branch.current) onCheckout(branch.name);
            }}>
              {branch.current ? <Check size={12} /> : <span className="git-branch-spacer" />}
              <span>{branch.name}</span>
              {branch.upstream ? <small>{branch.upstream}</small> : null}
            </button>
          ))}
          <form className="git-branch-create" onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            onCreate(name.trim());
            setName("");
            setOpen(false);
          }}>
            <input value={name} placeholder="新分支名，回车创建并切换" aria-label="新分支名" onChange={(event) => setName(event.target.value)} />
          </form>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 右侧作业栏的 Git 面板：看改动、看 diff、暂存、提交、推送拉取、切换分支。
 *
 * 和 VS Code 的源代码管理一个思路。暂存区和工作区分两组列；一个文件可以同时出现
 * 在两组里（暂存了一部分又接着改）。点文件名看 diff，单栏和左右对照可以切换。
 */
export function GitPanel({ cwd, active }: { cwd?: string; active: boolean }): React.JSX.Element {
  const git = useGit(cwd, active);
  const [view, setView] = useState<{ path: string; staged: boolean }>();
  const [message, setMessage] = useState("");
  const [discarding, setDiscarding] = useState<{ paths: string[]; label: string }>();
  const files = git.status?.files ?? [];
  const staged = files.filter((file) => file.staged);
  const unstaged = files.filter((file) => file.unstaged);
  const busy = git.busy !== undefined;

  const commit = useCallback(async (): Promise<void> => {
    const ok = await git.run({ op: "commit", message, stageAll: staged.length === 0 });
    if (ok) {
      setMessage("");
      toastSuccess("已提交。");
    }
  }, [git, message, staged.length]);

  if (!cwd) return <div className="git-panel"><div className="git-empty">先打开一个工作区。</div></div>;
  if (git.status && !git.status.repository) {
    return <div className="git-panel"><div className="git-empty">这个工作区不在 git 仓库里。</div></div>;
  }
  if (view) {
    return (
      <div className="git-panel">
        <DiffView load={git.diff} path={view.path} staged={view.staged} onBack={() => setView(undefined)} />
      </div>
    );
  }
  const status = git.status;
  return (
    <div className="git-panel">
      <div className="git-toolbar">
        <BranchMenu
          current={status?.branch}
          load={git.branches}
          disabled={busy || !status}
          onCheckout={(branch) => { void git.run({ op: "checkout", branch }); }}
          onCreate={(name) => { void git.run({ op: "create_branch", name }); }}
        />
        <span className="git-sync" title={status?.upstream ? `上游 ${status.upstream}` : "还没有上游分支，第一次推送时会自动设置"}>
          {status?.ahead ? <span><ArrowUp size={11} />{status.ahead}</span> : null}
          {status?.behind ? <span><ArrowDown size={11} />{status.behind}</span> : null}
        </span>
        <button className="git-icon-button" type="button" aria-label="拉取" title="拉取（只快进）" disabled={busy || !status?.upstream} onClick={() => { void git.run({ op: "pull" }).then((ok) => ok && toastSuccess("已拉取。")); }}>
          {git.busy === "pull" ? <LoaderCircle size={14} className="spin" /> : <ArrowDown size={14} />}
        </button>
        <button className="git-icon-button" type="button" aria-label="推送" title="推送" disabled={busy || !status?.branch} onClick={() => { void git.run({ op: "push" }).then((ok) => ok && toastSuccess("已推送。")); }}>
          {git.busy === "push" ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}
        </button>
        <button className="git-icon-button" type="button" aria-label="刷新" disabled={busy} onClick={() => { void git.refresh(); }}><RefreshCw size={13} /></button>
      </div>

      {git.error ? <div className="git-error" role="alert">{git.error}</div> : null}

      <div className="git-commit">
        <textarea
          value={message}
          placeholder={status?.branch ? `提交说明（提交到 ${status.branch}）` : "提交说明"}
          aria-label="提交说明"
          rows={3}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && message.trim() && files.length && !busy) {
              event.preventDefault();
              void commit();
            }
          }}
        />
        <button className="git-commit-button" type="button" disabled={!message.trim() || !files.length || busy} onClick={() => { void commit(); }}>
          {git.busy === "commit" ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
          {staged.length ? `提交 ${staged.length} 个文件` : "暂存全部并提交"}
        </button>
      </div>

      {!status ? <div className="git-empty"><LoaderCircle size={14} className="spin" />正在读取 git 状态…</div> : null}
      {status && files.length === 0 ? <div className="git-empty">工作区是干净的，没有改动。</div> : null}

      {staged.length ? (
        <section className="git-section">
          <header>
            <span>已暂存的更改 <b>{staged.length}</b></span>
            <button className="git-icon-button" type="button" aria-label="全部取消暂存" disabled={busy} onClick={() => { void git.run({ op: "unstage", paths: staged.map((file) => file.path) }); }}><Minus size={13} /></button>
          </header>
          <ul>
            {staged.map((file) => (
              <FileRow key={`staged:${file.path}`} file={file} state={file.staged!} onOpen={() => setView({ path: file.path, staged: true })} actions={(
                <button className="git-icon-button" type="button" aria-label={`取消暂存 ${file.path}`} disabled={busy} onClick={() => { void git.run({ op: "unstage", paths: [file.path] }); }}><Minus size={13} /></button>
              )} />
            ))}
          </ul>
        </section>
      ) : null}

      {unstaged.length ? (
        <section className="git-section">
          <header>
            <span>更改 <b>{unstaged.length}</b></span>
            <button className="git-icon-button" type="button" aria-label="全部丢弃" disabled={busy} onClick={() => setDiscarding({ paths: unstaged.map((file) => file.path), label: `全部 ${unstaged.length} 个文件` })}><Undo2 size={13} /></button>
            <button className="git-icon-button" type="button" aria-label="全部暂存" disabled={busy} onClick={() => { void git.run({ op: "stage", paths: unstaged.map((file) => file.path) }); }}><Plus size={13} /></button>
          </header>
          <ul>
            {unstaged.map((file) => (
              <FileRow key={`unstaged:${file.path}`} file={file} state={file.unstaged!} onOpen={() => setView({ path: file.path, staged: false })} actions={(
                <>
                  <button className="git-icon-button" type="button" aria-label={`丢弃 ${file.path}`} disabled={busy} onClick={() => setDiscarding({ paths: [file.path], label: file.path })}><Undo2 size={13} /></button>
                  <button className="git-icon-button" type="button" aria-label={`暂存 ${file.path}`} disabled={busy} onClick={() => { void git.run({ op: "stage", paths: [file.path] }); }}><Plus size={13} /></button>
                </>
              )} />
            ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={Boolean(discarding)}
        title="丢弃改动？"
        description={`${discarding?.label ?? ""} 在工作区里的改动会被丢掉，未跟踪的文件会被删除。已暂存的部分不受影响。这一步没法撤销。`}
        onClose={() => setDiscarding(undefined)}
        actions={[
          { label: "取消", onClick: () => setDiscarding(undefined), autoFocus: true },
          { label: "丢弃", variant: "danger", onClick: () => {
            const paths = discarding?.paths ?? [];
            setDiscarding(undefined);
            void git.run({ op: "discard", paths });
          } },
        ]}
      />
    </div>
  );
}
