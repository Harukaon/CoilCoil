import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Folder,
  FolderOpen,
  GitFork,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProjectSelection, SessionSummary } from "@suocode/runtime-protocol";
import { SuoLoader } from "../../ui/SuoLoader";
import { ArchivedSessionsDialog } from "./ArchivedSessionsDialog";
import { collectPinnedSessions, collapsedSessionLimit, nextExpandedSessionLimit, SESSION_EXPANSION_BATCH, type PinnedSessionEntry } from "./sessionList";

export interface SessionActivityState {
  runtimeId?: string;
  running: boolean;
  unread: boolean;
}

function relativeTime(value: string): string {
  const milliseconds = Date.now() - Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "刚刚";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天` : new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function GlobalPinnedSessionRow({ entry, onOpen, onUnpin, onArchive }: {
  entry: PinnedSessionEntry;
  onOpen: () => void;
  onUnpin: () => void;
  onArchive: () => void;
}): React.JSX.Element {
  const { project, session } = entry;
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <div className="conversation-row-wrap pinned-conversation-row-wrap">
        <button className="conversation-row pinned-conversation-row" type="button" onClick={onOpen}>
          <span className="conversation-status"><Pin size={11} strokeWidth={2} /></span>
          <span className="conversation-title-text">{session.title}</span>
          <span className="pinned-conversation-project" title={project.path}>{project.name}</span>
          <time>{relativeTime(session.updatedAt)}</time>
        </button>
        <button className="conversation-archive-btn" type="button" title="归档" onClick={(event) => { event.stopPropagation(); onArchive(); }}><Archive size={12} /></button>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
        <ContextMenu.Item className="conversation-context-item" onSelect={onUnpin}><PinOff size={13} /><span>取消置顶</span></ContextMenu.Item>
        <ContextMenu.Separator className="conversation-context-separator" />
        <ContextMenu.Item className="conversation-context-item" onSelect={onArchive}>归档对话</ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

export function WorkspaceSidebar({
  projects,
  activeProject,
  activeSessionId,
  pendingProjectPath,
  sessionsByProject,
  sessionActivity,
  expandedProjects,
  expandedSessionLimits,
  modelLabel,
  onNewConversation,
  onOpenProject,
  onToggleProject,
  onShowMoreSessions,
  onCollapseSessions,
  onOpenConversation,
  onArchiveConversation,
  onRenameConversation,
  onPinConversation,
  onForkConversation,
  onRestoreSessions,
  onFocusPending,
  skillsOpen,
  onOpenSkills,
  onOpenSettings,
  onRemoveProject,
  onError,
}: {
  projects: ProjectSelection[];
  activeProject: ProjectSelection | null;
  activeSessionId?: string;
  pendingProjectPath?: string;
  sessionsByProject: Record<string, SessionSummary[]>;
  sessionActivity: Record<string, SessionActivityState>;
  expandedProjects: Set<string>;
  expandedSessionLimits: Record<string, number>;
  modelLabel: string;
  onNewConversation: (project?: ProjectSelection) => void;
  onOpenProject: () => void;
  onToggleProject: (path: string) => void;
  onShowMoreSessions: (path: string, limit: number) => void;
  onCollapseSessions: (path: string) => void;
  onOpenConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onArchiveConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onRenameConversation: (project: ProjectSelection, session: SessionSummary, name: string) => Promise<void> | void;
  onPinConversation: (project: ProjectSelection, session: SessionSummary, pinned: boolean) => void;
  onForkConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onRestoreSessions: (project: ProjectSelection, sessions: SessionSummary[]) => void;
  onFocusPending: () => void;
  skillsOpen: boolean;
  onOpenSkills: () => void;
  onOpenSettings: () => void;
  onRemoveProject: (project: ProjectSelection) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const pinnedSessions = collectPinnedSessions(projects, sessionsByProject);

  useEffect(() => {
    if (!renamingPath) return;
    requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
  }, [renamingPath]);

  const commitRename = async (project: ProjectSelection, session: SessionSummary): Promise<void> => {
    const next = renameDraft.trim();
    setRenamingPath(undefined);
    if (!next || next === session.title) return;
    try {
      await onRenameConversation(project, session, next);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-drag"><div className="window-drag sidebar-drag-region" /></div>
      <nav className="primary-nav">
        <button className="nav-button" type="button" disabled={!activeProject} onClick={() => onNewConversation()}><MessageSquarePlus size={16} strokeWidth={1.7} /><span>新建对话</span><kbd>⌘N</kbd></button>
        <button className={`nav-button ${skillsOpen ? "active" : ""}`} type="button" onClick={onOpenSkills}><Sparkles size={16} strokeWidth={1.7} /><span>技能</span></button>
      </nav>
      {pinnedSessions.length ? <section className="pinned-sessions-section">
        <div className="section-heading"><span>置顶</span><span className="pinned-count">{pinnedSessions.length}</span></div>
        <div className="conversation-list pinned-conversation-list">
          {pinnedSessions.map((entry) => <GlobalPinnedSessionRow
            key={entry.session.path}
            entry={entry}
            onOpen={() => onOpenConversation(entry.project, entry.session)}
            onUnpin={() => onPinConversation(entry.project, entry.session, false)}
            onArchive={() => onArchiveConversation(entry.project, entry.session)}
          />)}
        </div>
      </section> : null}
      <section className="project-section">
        <div className="section-heading"><span>项目</span><span className="section-heading-actions"><ArchivedSessionsDialog projects={projects} onRestored={onRestoreSessions} onError={onError} /><button className="icon-button" type="button" aria-label="打开项目" onClick={onOpenProject}><FolderOpen size={15} strokeWidth={1.7} /></button></span></div>
        {projects.length ? projects.map((project) => {
          const expanded = expandedProjects.has(project.path);
          const allSessions = sessionsByProject[project.path] ?? [];
          const sessions = allSessions.filter((session) => !session.pinned);
          const hasPending = pendingProjectPath === project.path;
          const collapsedLimit = collapsedSessionLimit(hasPending);
          const visibleLimit = Math.max(collapsedLimit, expandedSessionLimits[project.path] ?? collapsedLimit);
          const visibleSessions = sessions.slice(0, visibleLimit);
          const hiddenCount = sessions.length - visibleSessions.length;
          return (
            <div className={`project-tree ${project.path === activeProject?.path ? "active" : ""}`} key={project.path}>
              <ContextMenu.Root>
                <ContextMenu.Trigger asChild>
                  <div className="project-row">
                    <button className="project-toggle" type="button" aria-expanded={expanded} onClick={() => onToggleProject(project.path)}>
                      <span className="project-leading"><Folder className="project-folder-icon" size={15} strokeWidth={1.7} />{expanded ? <ChevronDown className="project-hover-icon" size={14} /> : <ChevronRight className="project-hover-icon" size={14} />}</span>
                      <span className="project-name">{project.name}</span>
                    </button>
                    <span className="project-row-actions">
                      <button className="project-action" type="button" aria-label={`在 ${project.name} 中新建对话`} onClick={() => onNewConversation(project)}><Plus size={14} /></button>
                    </span>
                  </div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
                    <ContextMenu.Item
                      className="conversation-context-item"
                      disabled={project.kind === "home"}
                      onSelect={() => onRemoveProject(project)}
                    >
                      <span>卸载工作区</span>
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
              <div className={`conversation-list-shell ${expanded ? "expanded" : ""}`} aria-hidden={!expanded}>
                <div className="conversation-list">
                  {hasPending ? <button className="conversation-row active pending" type="button" onClick={onFocusPending}><span className="conversation-status"><Circle size={11} strokeWidth={1.7} /></span><span className="conversation-title-text">新对话</span><time>刚刚</time></button> : null}
                  {visibleSessions.map((session) => {
                    const activity = sessionActivity[session.path];
                    const renaming = renamingPath === session.path;
                    const status = activity?.running
                      ? <SuoLoader size={11} />
                      : activity?.unread
                        ? <i className="conversation-unread" />
                        : session.pinned
                          ? <Pin size={11} strokeWidth={2} />
                          : null;
                    return <ContextMenu.Root key={session.id}>
                      <ContextMenu.Trigger asChild>
                        <div className="conversation-row-wrap">
                          {renaming ? (
                            <div className={`conversation-row renaming ${project.path === activeProject?.path && session.id === activeSessionId ? "active" : ""}`}>
                              {session.pinned ? <span className="conversation-status"><Pin size={11} strokeWidth={2} /></span> : null}
                              <input
                                ref={renameRef}
                                className="conversation-rename-input"
                                value={renameDraft}
                                aria-label="重命名对话"
                                onChange={(event) => setRenameDraft(event.target.value)}
                                onBlur={() => { void commitRename(project, session); }}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    setRenamingPath(undefined);
                                  } else if (event.key === "Enter") {
                                    event.preventDefault();
                                    void commitRename(project, session);
                                  }
                                }}
                              />
                            </div>
                          ) : (
                            <button
                              className={`conversation-row ${project.path === activeProject?.path && session.id === activeSessionId ? "active" : ""}`}
                              type="button"
                              onClick={() => onOpenConversation(project, session)}
                            >
                              {status ? <span className="conversation-status">{status}</span> : null}
                              <span className="conversation-title-text">{session.title}</span>
                              <time>{relativeTime(session.updatedAt)}</time>
                            </button>
                          )}
                          {!renaming ? (
                            <button
                              className="conversation-archive-btn"
                              type="button"
                              title="归档"
                              onClick={(e) => { e.stopPropagation(); onArchiveConversation(project, session); }}
                            >
                              <Archive size={12} />
                            </button>
                          ) : null}
                        </div>
                      </ContextMenu.Trigger>
                      <ContextMenu.Portal>
                        <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
                          <ContextMenu.Item
                            className="conversation-context-item"
                            disabled={activity?.running}
                            onSelect={(event) => {
                              event.preventDefault();
                              setRenameDraft(session.title);
                              setRenamingPath(session.path);
                            }}
                          >
                            <Pencil size={13} /><span>重命名</span>
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            className="conversation-context-item"
                            disabled={activity?.running}
                            onSelect={() => onPinConversation(project, session, !session.pinned)}
                          >
                            {session.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                            <span>{session.pinned ? "取消置顶" : "置顶"}</span>
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            className="conversation-context-item"
                            disabled={activity?.running}
                            onSelect={() => onForkConversation(project, session)}
                          >
                            <GitFork size={13} /><span>复制对话</span>
                          </ContextMenu.Item>
                          <ContextMenu.Separator className="conversation-context-separator" />
                          <ContextMenu.Item className="conversation-context-item" disabled={activity?.running} onSelect={() => onArchiveConversation(project, session)}>归档对话</ContextMenu.Item>
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    </ContextMenu.Root>;
                  })}
                  {hiddenCount > 0 ? <button className="more-conversations" type="button" aria-label={`再显示 ${Math.min(SESSION_EXPANSION_BATCH, hiddenCount)} 个对话`} onClick={() => onShowMoreSessions(project.path, nextExpandedSessionLimit(visibleSessions.length, sessions.length))}><MoreHorizontal size={15} /></button> : null}
                  {visibleLimit > collapsedLimit ? <button className="more-conversations" type="button" aria-label="收起更多对话" onClick={() => onCollapseSessions(project.path)}><ChevronUp size={14} /></button> : null}
                  {!allSessions.length && !hasPending ? <p className="empty-conversations">暂无对话</p> : null}
                </div>
              </div>
            </div>
          );
        }) : (
          <button className="open-project-card" type="button" onClick={onOpenProject}><span className="open-project-icon"><Plus size={14} /></span><span><strong>打开项目</strong><small>选择本地文件夹</small></span></button>
        )}
      </section>
      <div className="sidebar-footer"><div className="brand-mark">S</div><div className="brand-copy"><strong>SuoCode</strong><span>{modelLabel}</span></div><button className="icon-button" type="button" aria-label="设置" onClick={onOpenSettings}><Settings size={17} strokeWidth={1.7} /></button></div>
    </aside>
  );
}
