import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Archive,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Folder,
  FolderInput,
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
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import { primaryModifierLabel } from "../../../../shared/platform-labels";
import { OrbitLoader } from "../../ui/loaders";
import { CoilLogo } from "../../ui/CoilLogo";
import { ArchivedSessionsDialog } from "./ArchivedSessionsDialog";
import { collectRecentSessions, DEFAULT_RECENT_ROWS, loadRecentSectionCollapsed, saveRecentSectionCollapsed, type RecentOpens } from "./recentSessions";
import { collectPinnedSessions, collapsedSessionLimit, conversationStatusKind, nextExpandedSessionLimit, SESSION_EXPANSION_BATCH, summarizeWorkspaceActivity, workspaceActivityLabel, type ConversationStatusKind, type PinnedSessionEntry } from "./sessionList";

export interface SessionActivityState {
  runtimeId?: string;
  running: boolean;
  unread: boolean;
}

/** The icon for a row's status; see {@link conversationStatusKind} for the order. */
function conversationStatusMarker(kind: ConversationStatusKind): React.JSX.Element | null {
  if (kind === "running") return <OrbitLoader size={10} />;
  if (kind === "unread") return <i className="conversation-unread" />;
  if (kind === "pinned") return <Pin size={11} strokeWidth={2} />;
  return null;
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

/**
 * The row of controls under a conversation list.
 *
 * Growing a list was one-way: every list could only be expanded, so a workspace
 * opened once to find something stayed tall for the rest of the session. The
 * two controls sit together and either can be absent.
 */
function ConversationListControls({ hiddenCount, expandedBy, onShowMore, onCollapse }: {
  hiddenCount: number;
  /** How many rows beyond the default are on screen; zero hides the collapse control. */
  expandedBy: number;
  onShowMore: () => void;
  onCollapse: () => void;
}): React.JSX.Element | null {
  if (hiddenCount <= 0 && expandedBy <= 0) return null;
  return <div className="conversation-list-controls">
    {hiddenCount > 0
      ? <button className="more-conversations" type="button" aria-label={`再显示 ${Math.min(SESSION_EXPANSION_BATCH, hiddenCount)} 个对话`} onClick={onShowMore}><MoreHorizontal size={15} /></button>
      : null}
    {expandedBy > 0
      ? <button className="more-conversations" type="button" aria-label="收起对话" onClick={onCollapse}><ChevronUp size={15} /></button>
      : null}
  </div>;
}

/**
 * A conversation row that names its own workspace.
 *
 * The pinned and recent sections both list conversations from every workspace at
 * once, so unlike the rows nested under a project these have to say where they
 * come from. Only the context menu differs between the two.
 */
function CrossProjectSessionRow({ project, session, activity, pinned, active, timestamp, onOpen, onArchive, menu }: {
  project: ProjectSelection;
  session: SessionSummary;
  activity?: SessionActivityState;
  pinned: boolean;
  active: boolean;
  timestamp: string;
  onOpen: () => void;
  onArchive: () => void;
  menu: React.ReactNode;
}): React.JSX.Element {
  // These are the rows most often watched from another project, so they are the
  // ones that most need to say whether the agent is still working and whether
  // what it finished has been read.
  const status = conversationStatusMarker(conversationStatusKind(activity, pinned));
  const variant = pinned ? "pinned" : "recent";
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <div className={`conversation-row-wrap ${variant}-conversation-row-wrap`}>
        <button className={`conversation-row ${variant}-conversation-row ${active ? "active" : ""}`} type="button" onClick={onOpen}>
          <span className="conversation-status">{status}</span>
          <span className="conversation-title-text">{session.title}</span>
          <span className="pinned-conversation-project" title={project.path}>{project.name}</span>
          <time>{relativeTime(timestamp)}</time>
        </button>
        <button className="conversation-archive-btn" type="button" title="归档" onClick={(event) => { event.stopPropagation(); onArchive(); }}><Archive size={12} /></button>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>{menu}</ContextMenu.Content>
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
  recentOpens,
  expandedProjects,
  expandedSessionLimits,
  modelLabel,
  onNewConversation,
  onOpenProject,
  onToggleProject,
  onShowMoreSessions,
  onOpenConversation,
  onArchiveConversation,
  onRenameConversation,
  onPinConversation,
  onForkConversation,
  onMoveConversation,
  onReorderProjects,
  onRestoreSessions,
  onFocusPending,
  skillsOpen,
  onOpenSkills,
  memoryOpen,
  onOpenMemory,
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
  recentOpens: RecentOpens;
  expandedProjects: Set<string>;
  expandedSessionLimits: Record<string, number>;
  modelLabel: string;
  onNewConversation: (project?: ProjectSelection) => void;
  onOpenProject: () => void;
  onToggleProject: (path: string) => void;
  onShowMoreSessions: (path: string, limit: number) => void;
  onOpenConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onArchiveConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onRenameConversation: (project: ProjectSelection, session: SessionSummary, name: string) => Promise<void> | void;
  onPinConversation: (project: ProjectSelection, session: SessionSummary, pinned: boolean) => void;
  onForkConversation: (project: ProjectSelection, session: SessionSummary) => void;
  onMoveConversation: (project: ProjectSelection, session: SessionSummary, target: ProjectSelection) => void;
  onReorderProjects: (fromPath: string, toPath: string) => void;
  onRestoreSessions: (project: ProjectSelection, sessions: SessionSummary[]) => void;
  onFocusPending: () => void;
  skillsOpen: boolean;
  onOpenSkills: () => void;
  memoryOpen: boolean;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
  onRemoveProject: (project: ProjectSelection) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const [draggingPath, setDraggingPath] = useState<string>();
  const [dropTargetPath, setDropTargetPath] = useState<string>();
  const renameRef = useRef<HTMLInputElement>(null);
  const [recentCollapsed, setRecentCollapsed] = useState(loadRecentSectionCollapsed);
  const [recentLimit, setRecentLimit] = useState(DEFAULT_RECENT_ROWS);
  const pinnedSessions = collectPinnedSessions(projects, sessionsByProject);
  const recentSessions = collectRecentSessions(projects, sessionsByProject, recentOpens);
  const visibleRecent = recentSessions.slice(0, recentLimit);
  // The home project is recomputed as the first entry on every launch, so only
  // the mounted workspaces have an order worth persisting.
  const reorderable = (target: ProjectSelection): boolean => target.kind === "workspace";

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
        <button className="nav-button" type="button" disabled={!activeProject} onClick={() => onNewConversation()}><MessageSquarePlus size={16} strokeWidth={1.7} /><span>新建对话</span><kbd>{primaryModifierLabel(window.coilcoil.platform)}N</kbd></button>
        <button className={`nav-button ${skillsOpen ? "active" : ""}`} type="button" onClick={onOpenSkills}><Sparkles size={16} strokeWidth={1.7} /><span>技能</span></button>
        <button className={`nav-button ${memoryOpen ? "active" : ""}`} type="button" onClick={onOpenMemory}><BookOpen size={16} strokeWidth={1.7} /><span>记忆</span></button>
      </nav>
      <section className="project-section">
        {/* No heading and no count: the pin on each row already says what these are,
            and a 36px section title only costs vertical space. */}
        {pinnedSessions.length ? <section className="pinned-sessions-section">
          <div className="conversation-list pinned-conversation-list">
            {pinnedSessions.map((entry) => <CrossProjectSessionRow
              key={entry.session.path}
              project={entry.project}
              session={entry.session}
              activity={sessionActivity[entry.session.path]}
              pinned
              active={entry.project.path === activeProject?.path && entry.session.id === activeSessionId}
              timestamp={entry.session.updatedAt}
              onOpen={() => onOpenConversation(entry.project, entry.session)}
              onArchive={() => onArchiveConversation(entry.project, entry.session)}
              menu={<>
                <ContextMenu.Item className="conversation-context-item" onSelect={() => onPinConversation(entry.project, entry.session, false)}><PinOff size={13} /><span>取消置顶</span></ContextMenu.Item>
                <ContextMenu.Separator className="conversation-context-separator" />
                <ContextMenu.Item className="conversation-context-item" onSelect={() => onArchiveConversation(entry.project, entry.session)}>归档对话</ContextMenu.Item>
              </>}
            />)}
          </div>
        </section> : null}
        {recentSessions.length ? <section className="recent-sessions-section">
          <button
            className="section-heading section-heading-toggle"
            type="button"
            aria-expanded={!recentCollapsed}
            onClick={() => setRecentCollapsed((current) => { saveRecentSectionCollapsed(!current); return !current; })}
          >
            <span>最近</span>
            <ChevronRight className={`section-heading-chevron ${recentCollapsed ? "" : "expanded"}`} size={13} strokeWidth={2} />
          </button>
          {recentCollapsed ? null : <div className="conversation-list recent-conversation-list">
            {visibleRecent.map((entry) => <CrossProjectSessionRow
              key={entry.session.path}
              project={entry.project}
              session={entry.session}
              activity={sessionActivity[entry.session.path]}
              pinned={false}
              active={entry.project.path === activeProject?.path && entry.session.id === activeSessionId}
              timestamp={new Date(entry.at).toISOString()}
              onOpen={() => onOpenConversation(entry.project, entry.session)}
              onArchive={() => onArchiveConversation(entry.project, entry.session)}
              menu={<>
                <ContextMenu.Item className="conversation-context-item" onSelect={() => onPinConversation(entry.project, entry.session, true)}><Pin size={13} /><span>置顶</span></ContextMenu.Item>
                <ContextMenu.Separator className="conversation-context-separator" />
                <ContextMenu.Item className="conversation-context-item" onSelect={() => onArchiveConversation(entry.project, entry.session)}>归档对话</ContextMenu.Item>
              </>}
            />)}
            <ConversationListControls
              hiddenCount={recentSessions.length - visibleRecent.length}
              expandedBy={visibleRecent.length - DEFAULT_RECENT_ROWS}
              onShowMore={() => setRecentLimit(nextExpandedSessionLimit(visibleRecent.length, recentSessions.length))}
              onCollapse={() => setRecentLimit(DEFAULT_RECENT_ROWS)}
            />
          </div>}
        </section> : null}
        <div className="section-heading"><span>项目</span><span className="section-heading-actions"><ArchivedSessionsDialog projects={projects} activeProject={activeProject} onRestored={onRestoreSessions} onError={onError} /><button className="icon-button" type="button" aria-label="打开项目" onClick={onOpenProject}><FolderOpen size={15} strokeWidth={1.7} /></button></span></div>
        {projects.length ? projects.map((project) => {
          const expanded = expandedProjects.has(project.path);
          const allSessions = sessionsByProject[project.path] ?? [];
          const sessions = allSessions.filter((session) => !session.pinned);
          const hasPending = pendingProjectPath === project.path;
          // Collapsed workspaces hide their running conversations; the folder
          // row carries their state so nothing is forgotten in there.
          const workspaceActivity = summarizeWorkspaceActivity(allSessions, sessionActivity);
          const workspaceActivityText = workspaceActivityLabel(workspaceActivity);
          const collapsedLimit = collapsedSessionLimit(hasPending);
          const visibleLimit = Math.max(collapsedLimit, expandedSessionLimits[project.path] ?? collapsedLimit);
          const visibleSessions = sessions.slice(0, visibleLimit);
          const hiddenCount = sessions.length - visibleSessions.length;
          return (
            <div className={`project-tree ${project.path === activeProject?.path ? "active" : ""}`} key={project.path}>
              <ContextMenu.Root>
                <ContextMenu.Trigger asChild>
                  <div
                    className={`project-row ${draggingPath === project.path ? "dragging" : ""} ${dropTargetPath === project.path ? "drop-target" : ""}`}
                    draggable={reorderable(project)}
                    onDragStart={(event) => {
                      if (!reorderable(project)) return;
                      event.dataTransfer.effectAllowed = "move";
                      // Firefox refuses to start a drag without payload, and a
                      // plain-text path is also what an external drop expects.
                      event.dataTransfer.setData("text/plain", project.path);
                      setDraggingPath(project.path);
                    }}
                    onDragOver={(event) => {
                      if (!draggingPath || draggingPath === project.path || !reorderable(project)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTargetPath(project.path);
                    }}
                    onDragLeave={() => setDropTargetPath((current) => current === project.path ? undefined : current)}
                    onDrop={(event) => {
                      event.preventDefault();
                      const from = draggingPath;
                      setDraggingPath(undefined);
                      setDropTargetPath(undefined);
                      if (from && from !== project.path && reorderable(project)) onReorderProjects(from, project.path);
                    }}
                    onDragEnd={() => { setDraggingPath(undefined); setDropTargetPath(undefined); }}
                  >
                    <button className="project-toggle" type="button" aria-expanded={expanded} onClick={() => onToggleProject(project.path)}>
                      <span className="project-leading"><Folder className="project-folder-icon" size={15} strokeWidth={1.7} />{expanded ? <ChevronDown className="project-hover-icon" size={14} /> : <ChevronRight className="project-hover-icon" size={14} />}</span>
                      <span className="project-name">{project.name}</span>
                      {workspaceActivityText ? (
                        <i
                          className={`project-activity ${workspaceActivity.running ? "running" : "unread"}`}
                          role="img"
                          aria-label={workspaceActivityText}
                          title={workspaceActivityText}
                        />
                      ) : null}
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
                    const status = conversationStatusMarker(conversationStatusKind(activity, Boolean(session.pinned)));
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
                          <ContextMenu.Sub>
                            <ContextMenu.SubTrigger
                              className="conversation-context-item"
                              disabled={activity?.running || projects.length < 2}
                            >
                              <FolderInput size={13} /><span>移动到工作区</span><ChevronRight className="conversation-context-more" size={13} />
                            </ContextMenu.SubTrigger>
                            <ContextMenu.Portal>
                              <ContextMenu.SubContent className="conversation-context-menu" sideOffset={2} collisionPadding={8}>
                                {projects.filter((target) => target.path !== project.path).map((target) => (
                                  <ContextMenu.Item
                                    className="conversation-context-item"
                                    key={target.path}
                                    onSelect={() => onMoveConversation(project, session, target)}
                                  >
                                    <Folder size={13} /><span className="conversation-context-label" title={target.path}>{target.name}</span>
                                  </ContextMenu.Item>
                                ))}
                              </ContextMenu.SubContent>
                            </ContextMenu.Portal>
                          </ContextMenu.Sub>
                          <ContextMenu.Separator className="conversation-context-separator" />
                          <ContextMenu.Item className="conversation-context-item" disabled={activity?.running} onSelect={() => onArchiveConversation(project, session)}>归档对话</ContextMenu.Item>
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    </ContextMenu.Root>;
                  })}
                  <ConversationListControls
                    hiddenCount={hiddenCount}
                    expandedBy={visibleSessions.length - collapsedLimit}
                    onShowMore={() => onShowMoreSessions(project.path, nextExpandedSessionLimit(visibleSessions.length, sessions.length))}
                    onCollapse={() => onShowMoreSessions(project.path, collapsedLimit)}
                  />
                  {!allSessions.length && !hasPending ? <p className="empty-conversations">暂无对话</p> : null}
                </div>
              </div>
            </div>
          );
        }) : (
          <button className="open-project-card" type="button" onClick={onOpenProject}><span className="open-project-icon"><Plus size={14} /></span><span><strong>打开项目</strong><small>选择本地文件夹</small></span></button>
        )}
      </section>
      <div className="sidebar-footer"><div className="brand-mark"><CoilLogo size={26} /></div><div className="brand-copy"><strong>CoilCoil</strong><span>{modelLabel}</span></div><button className="icon-button" type="button" aria-label="设置" onClick={onOpenSettings}><Settings size={17} strokeWidth={1.7} /></button></div>
    </aside>
  );
}
