import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleDot,
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
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProjectSelection, SessionSummary } from "@suocode/runtime-protocol";
import { SuoLoader } from "../../ui/SuoLoader";
import { ArchivedSessionsPopover } from "./ArchivedSessionsPopover";

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

export function WorkspaceSidebar({
  projects,
  activeProject,
  activeSessionId,
  pendingProjectPath,
  sessionsByProject,
  sessionActivity,
  expandedProjects,
  expandedSessionLists,
  modelLabel,
  onNewConversation,
  onOpenProject,
  onToggleProject,
  onShowAllSessions,
  onCollapseSessions,
  onOpenConversation,
  onArchiveConversation,
  onRenameConversation,
  onPinConversation,
  onForkConversation,
  onRestoreSessions,
  onFocusPending,
  onOpenSettings,
  onError,
}: {
  projects: ProjectSelection[];
  activeProject: ProjectSelection | null;
  activeSessionId?: string;
  pendingProjectPath?: string;
  sessionsByProject: Record<string, SessionSummary[]>;
  sessionActivity: Record<string, SessionActivityState>;
  expandedProjects: Set<string>;
  expandedSessionLists: Set<string>;
  modelLabel: string;
  onNewConversation: (project?: ProjectSelection) => void;
  onOpenProject: () => void;
  onToggleProject: (path: string) => void;
  onShowAllSessions: (path: string) => void;
  onCollapseSessions: (path: string) => void;
  onOpenConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onArchiveConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onRenameConversation: (project: ProjectSelection, session: SessionSummary, name: string) => Promise<void> | void;
  onPinConversation: (project: ProjectSelection, session: SessionSummary, pinned: boolean) => void;
  onForkConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onRestoreSessions: (project: ProjectSelection, sessions: SessionSummary[]) => void;
  onFocusPending: () => void;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

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
      <nav className="primary-nav"><button className="nav-button" type="button" disabled={!activeProject} onClick={() => onNewConversation()}><MessageSquarePlus size={18} strokeWidth={1.7} /><span>新建对话</span><kbd>⌘N</kbd></button></nav>
      <section className="project-section">
        <div className="section-heading"><span>项目</span><span className="section-heading-actions"><ArchivedSessionsPopover projects={projects} onRestored={onRestoreSessions} onError={onError} /><button className="icon-button" type="button" aria-label="打开项目" onClick={onOpenProject}><FolderOpen size={15} strokeWidth={1.7} /></button></span></div>
        {projects.length ? projects.map((project) => {
          const expanded = expandedProjects.has(project.path);
          const sessions = sessionsByProject[project.path] ?? [];
          const hasPending = pendingProjectPath === project.path;
          const showAll = expandedSessionLists.has(project.path);
          const visibleSessions = showAll ? sessions : sessions.slice(0, hasPending ? 3 : 4);
          const hiddenCount = sessions.length - visibleSessions.length;
          return (
            <div className={`project-tree ${project.path === activeProject?.path ? "active" : ""}`} key={project.path}>
              <div className="project-row">
                <button className="project-toggle" type="button" aria-expanded={expanded} onClick={() => onToggleProject(project.path)}>
                  <span className="project-leading"><Folder className="project-folder-icon" size={15} strokeWidth={1.7} />{expanded ? <ChevronDown className="project-hover-icon" size={14} /> : <ChevronRight className="project-hover-icon" size={14} />}</span>
                  <span className="project-name">{project.name}</span>
                </button>
                <span className="project-row-actions">
                  <button className="project-action" type="button" aria-label={`在 ${project.name} 中新建对话`} onClick={() => onNewConversation(project)}><Plus size={14} /></button>
                </span>
              </div>
              <div className={`conversation-list-shell ${expanded ? "expanded" : ""}`} aria-hidden={!expanded}>
                <div className="conversation-list">
                  {hasPending ? <button className="conversation-row active pending" type="button" onClick={onFocusPending}><span className="conversation-status"><Circle size={11} strokeWidth={1.7} /></span><span className="conversation-title-text">新对话</span><time>刚刚</time></button> : null}
                  {visibleSessions.map((session) => {
                    const activity = sessionActivity[session.path];
                    const renaming = renamingPath === session.path;
                    return <ContextMenu.Root key={session.id}>
                      <ContextMenu.Trigger asChild>
                        {renaming ? (
                          <div className={`conversation-row renaming ${project.path === activeProject?.path && session.id === activeSessionId ? "active" : ""}`}>
                            <span className="conversation-status">{session.pinned ? <Pin size={11} strokeWidth={2} /> : <CircleDot size={11} strokeWidth={2} />}</span>
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
                            <span className="conversation-status">
                              {activity?.running ? <SuoLoader size={11} /> : activity?.unread ? <i className="conversation-unread" /> : session.pinned ? <Pin size={11} strokeWidth={2} /> : <CircleDot size={11} strokeWidth={2} />}
                            </span>
                            <span className="conversation-title-text">{session.title}</span>
                            <time>{relativeTime(session.updatedAt)}</time>
                          </button>
                        )}
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
                            <GitFork size={13} /><span>Fork 对话</span>
                          </ContextMenu.Item>
                          <ContextMenu.Separator className="conversation-context-separator" />
                          <ContextMenu.Item className="conversation-context-item" disabled={activity?.running} onSelect={() => onArchiveConversation(project, session)}>归档对话</ContextMenu.Item>
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    </ContextMenu.Root>;
                  })}
                  {hiddenCount > 0 ? <button className="more-conversations" type="button" aria-label={`显示另外 ${hiddenCount} 个对话`} onClick={() => onShowAllSessions(project.path)}><MoreHorizontal size={15} /></button> : null}
                  {showAll && sessions.length > 4 ? <button className="more-conversations" type="button" aria-label="收起更多对话" onClick={() => onCollapseSessions(project.path)}><ChevronUp size={14} /></button> : null}
                  {!sessions.length && !hasPending ? <p className="empty-conversations">暂无对话</p> : null}
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
