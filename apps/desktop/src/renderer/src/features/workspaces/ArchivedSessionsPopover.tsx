import * as Popover from "@radix-ui/react-popover";
import { ArchiveRestore, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProjectSelection, SessionSummary } from "@suocode/runtime-protocol";

function archivedTime(value: string | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ArchivedSessionsPopover({
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
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="icon-button" type="button" aria-label="归档会话"><ArchiveRestore size={15} strokeWidth={1.7} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="archive-popover" side="right" align="start" sideOffset={8} collisionPadding={12}>
          <header><div><strong>归档会话</strong><small>{loading ? "正在读取…" : `${count} 个会话`}</small></div>{loading ? <LoaderCircle className="spin" size={14} /> : null}</header>
          <div className="archive-groups">
            {projects.map((project) => {
              const sessions = archives[project.path] ?? [];
              if (!sessions.length) return null;
              return <section key={project.path}><h3>{project.name}</h3>{sessions.map((session) => <div className="archive-session" key={session.path}><span><strong>{session.title}</strong><small>{archivedTime(session.archivedAt)}</small></span><button type="button" disabled={restoringPath === session.path} onClick={() => { void restore(project, session); }}>{restoringPath === session.path ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}恢复</button></div>)}</section>;
            })}
            {!loading && count === 0 ? <p className="archive-empty">暂无归档会话</p> : null}
          </div>
          <Popover.Arrow className="model-popover-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
