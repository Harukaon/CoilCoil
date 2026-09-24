import { ArrowDown, ArrowUp, Check, ChevronDown, GitBranch, LoaderCircle, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranch as GitBranchInfo, GitCommit, GitCommitFile } from "@coilcoil/runtime-protocol";
import { ConfirmDialog } from "../../ui/dialog";
import { toastSuccess } from "../../ui/toast";
import { DiffView } from "./GitDiffView";
import { FileRow } from "./GitFileRow";
import { GitHistory } from "./GitHistory";
import { useGit } from "./useGit";
import "./git.css";

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
 * 下面是可折叠的提交历史（带分支线条图），点提交看它改的文件，再点文件看 diff。
 */
export function GitPanel({ cwd, active }: { cwd?: string; active: boolean }): React.JSX.Element {
  const git = useGit(cwd, active);
  const [view, setView] = useState<
    | { kind: "change"; path: string; staged: boolean }
    | { kind: "commit"; commit: GitCommit; file: GitCommitFile }
  >();
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

  // DiffView 换了 load 才重新读，所以按看的是哪份 diff 固定下来。
  const { diff: loadChange, commitDiff } = git;
  const diffLoad = useMemo(() => {
    if (!view) return undefined;
    if (view.kind === "change") return () => loadChange(view.path, view.staged);
    return () => commitDiff(view.commit.hash, view.file.path, view.file.originalPath);
  }, [commitDiff, loadChange, view]);

  if (!cwd) return <div className="git-panel"><div className="git-empty">先打开一个工作区。</div></div>;
  if (git.status && !git.status.repository) {
    return <div className="git-panel"><div className="git-empty">这个工作区不在 git 仓库里。</div></div>;
  }
  const status = git.status;
  return (
    <div className="git-panel">
      {view && diffLoad ? (
        <DiffView
          load={diffLoad}
          path={view.kind === "change" ? view.path : view.file.path}
          label={view.kind === "change" ? (view.staged ? "已暂存" : "工作区") : `${view.commit.shortHash} ${view.commit.subject}`}
          onBack={() => setView(undefined)}
        />
      ) : null}
      {/* 看 diff 时列表只是藏起来：回来时历史展开到哪、滚到哪都还在。 */}
      <div className="git-main" hidden={Boolean(view)}>
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
                <FileRow key={`staged:${file.path}`} file={file} state={file.staged!} onOpen={() => setView({ kind: "change", path: file.path, staged: true })} actions={(
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
                <FileRow key={`unstaged:${file.path}`} file={file} state={file.unstaged!} onOpen={() => setView({ kind: "change", path: file.path, staged: false })} actions={(
                  <>
                    <button className="git-icon-button" type="button" aria-label={`丢弃 ${file.path}`} disabled={busy} onClick={() => setDiscarding({ paths: [file.path], label: file.path })}><Undo2 size={13} /></button>
                    <button className="git-icon-button" type="button" aria-label={`暂存 ${file.path}`} disabled={busy} onClick={() => { void git.run({ op: "stage", paths: [file.path] }); }}><Plus size={13} /></button>
                  </>
                )} />
              ))}
            </ul>
          </section>
        ) : null}

        <GitHistory status={status} log={git.log} commitFiles={git.commitFiles} onOpenFile={(commit, file) => setView({ kind: "commit", commit, file })} />
      </div>

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
