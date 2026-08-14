import { ArchiveRestore, LoaderCircle, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProjectSelection, SessionSummary } from "@suocode/runtime-protocol";
import { Modal } from "../../ui/dialog";
import { filterArchivedSessionGroups } from "./archiveSessions";

function archivedTime(value: string | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ArchivedSessionsDialog({
  projects,
  onRestored,
  onError,
}: {
  projects: ProjectSelection[];
  onRestored: (project: ProjectSelection, sessions: SessionSummary[]) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [restoringPath, setRestoringPath] = useState<string>();
  const [archives, setArchives] = useState<Record<string, SessionSummary[]>>({});
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all(projects.map(async (project) => [project.path, await window.suocode.request<SessionSummary[]>({ type: "list_archived_sessions", cwd: project.path })] as const))
      .then((entries) => { if (!cancelled) setArchives(Object.fromEntries(entries)); })
      .catch((caught) => { if (!cancelled) onError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onError, open, projects]);

  const count = useMemo(() => Object.values(archives).reduce((sum, sessions) => sum + sessions.length, 0), [archives]);
  const groups = useMemo(() => filterArchivedSessionGroups(projects, archives, query), [archives, projects, query]);
  const filteredCount = useMemo(() => groups.reduce((sum, group) => sum + group.sessions.length, 0), [groups]);

  const close = (): void => {
    setOpen(false);
    setQuery("");
  };

  const restore = async (project: ProjectSelection, session: SessionSummary): Promise<void> => {
    setRestoringPath(session.path);
    try {
      const sessions = await window.suocode.request<SessionSummary[]>({ type: "restore_session", cwd: project.path, sessionPath: session.path });
      setArchives((current) => ({ ...current, [project.path]: (current[project.path] ?? []).filter((item) => item.path !== session.path) }));
      onRestored(project, sessions);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRestoringPath(undefined);
    }
  };

  return (
    <>
      <button className="icon-button" type="button" aria-label="归档会话" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><ArchiveRestore size={15} strokeWidth={1.7} /></button>
      <Modal open={open} bare onClose={close}>
        <section className="archive-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-dialog-title">
          <header>
            <div><strong id="archive-dialog-title">归档会话</strong><small>{loading ? "正在读取…" : query.trim() ? `${filteredCount}/${count} 个会话` : `${count} 个会话`}</small></div>
            <span>{loading ? <LoaderCircle className="spin" size={14} /> : null}<button className="icon-button" type="button" aria-label="关闭归档会话" onClick={close}><X size={15} /></button></span>
          </header>
          <label className="archive-search"><Search size={14} /><input autoFocus value={query} placeholder="搜索归档会话标题" onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="archive-groups">
            {groups.map(({ project, sessions }) => <section key={project.path}><h3>{project.name}</h3>{sessions.map((session) => <div className="archive-session" key={session.path}><span><strong>{session.title}</strong><small>{archivedTime(session.archivedAt)}</small></span><button type="button" disabled={restoringPath === session.path} onClick={() => { void restore(project, session); }}>{restoringPath === session.path ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}恢复</button></div>)}</section>)}
            {!loading && count === 0 ? <p className="archive-empty">暂无归档会话</p> : null}
            {!loading && count > 0 && filteredCount === 0 ? <p className="archive-empty archive-filter-empty">没有匹配的归档会话</p> : null}
          </div>
        </section>
      </Modal>
    </>
  );
}
