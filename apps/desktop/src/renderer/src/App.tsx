import {
  ArrowUp,
  CheckSquare2,
  ChevronDown,
  CircleDot,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  GitCompareArrows,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { ProjectSelection } from "../../shared/desktop-api";

type InspectorView = "plan" | "changes" | "terminal" | "files";

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

const PROJECT_STORAGE_KEY = "suocode.selected-project";

function loadStoredProject(): ProjectSelection | null {
  try {
    const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<ProjectSelection>;
    if (typeof parsed.name !== "string" || typeof parsed.path !== "string") {
      return null;
    }
    return { name: parsed.name, path: parsed.path };
  } catch {
    return null;
  }
}

function EmptyInspector({ view }: { view: InspectorView }): React.JSX.Element {
  const content = {
    plan: {
      icon: CheckSquare2,
      title: "No active plan",
      detail: "The agent's plan will appear here.",
    },
    changes: {
      icon: GitCompareArrows,
      title: "No changes",
      detail: "File changes will appear while the agent works.",
    },
    terminal: {
      icon: TerminalSquare,
      title: "No running commands",
      detail: "Agent commands will appear here.",
    },
    files: {
      icon: Files,
      title: "No project open",
      detail: "Open a project to inspect its files.",
    },
  }[view];
  const Icon = content.icon;

  return (
    <div className="inspector-empty">
      <span className="inspector-empty-icon">
        <Icon size={16} strokeWidth={1.7} />
      </span>
      <strong>{content.title}</strong>
      <p>{content.detail}</p>
    </div>
  );
}

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<ProjectSelection | null>(loadStoredProject);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [inspectorView, setInspectorView] = useState<InspectorView>("plan");
  const [draft, setDraft] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.documentElement.dataset.platform = window.suocode.platform;
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations],
  );

  const openProject = async (): Promise<void> => {
    const selection = await window.suocode.selectProject();
    if (!selection) return;
    window.localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(selection));
    setProject(selection);
    setConversations([]);
    setActiveConversationId(null);
    inputRef.current?.focus();
  };

  const startNewConversation = (): void => {
    setActiveConversationId(null);
    setDraft("");
    inputRef.current?.focus();
  };

  const submitPrompt = (event: FormEvent): void => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || !project) return;

    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: prompt.split("\n", 1)[0].slice(0, 54),
      updatedAt: "now",
    };
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setDraft("");
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const inspectorItems: Array<{
    id: InspectorView;
    label: string;
    icon: typeof CheckSquare2;
    meta?: string;
  }> = [
    { id: "plan", label: "Plan", icon: CheckSquare2 },
    { id: "changes", label: "Changes", icon: GitCompareArrows, meta: "0" },
    { id: "terminal", label: "Terminal", icon: TerminalSquare },
    { id: "files", label: "Files", icon: Files },
  ];

  return (
    <main
      className={`app-shell ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`}
    >
      <aside className="sidebar">
        <div className="window-drag sidebar-drag">
          <button
            className="icon-button no-drag sidebar-toggle"
            type="button"
            aria-label="Hide sidebar"
            onClick={() => setLeftOpen(false)}
          >
            <PanelLeft size={17} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary">
          <button className="nav-button" type="button" onClick={startNewConversation}>
            <MessageSquarePlus size={18} strokeWidth={1.7} />
            <span>New chat</span>
          </button>
        </nav>

        <section className="project-section">
          <div className="section-heading">
            <span>Projects</span>
            <button
              className="icon-button"
              type="button"
              aria-label="Open project"
              onClick={() => void openProject()}
            >
              <FolderOpen size={17} strokeWidth={1.7} />
            </button>
          </div>

          {project ? (
            <div className="project-tree">
              <button className="project-row" type="button">
                <Folder size={17} strokeWidth={1.7} />
                <span>{project.name}</span>
                <ChevronDown size={14} />
              </button>
              <div className="conversation-list">
                {conversations.map((conversation) => (
                  <button
                    className={`conversation-row ${
                      conversation.id === activeConversationId ? "active" : ""
                    }`}
                    type="button"
                    key={conversation.id}
                    onClick={() => setActiveConversationId(conversation.id)}
                  >
                    <CircleDot size={13} strokeWidth={2} />
                    <span>{conversation.title}</span>
                    <time>{conversation.updatedAt}</time>
                  </button>
                ))}
                {conversations.length === 0 ? (
                  <p className="empty-conversations">No conversations yet</p>
                ) : null}
              </div>
            </div>
          ) : (
            <button className="open-project-card" type="button" onClick={() => void openProject()}>
              <span className="open-project-icon">
                <Plus size={16} />
              </span>
              <span>
                <strong>Open a project</strong>
                <small>Choose a local folder</small>
              </span>
            </button>
          )}
        </section>

        <div className="sidebar-footer">
          <div className="brand-mark">S</div>
          <div className="brand-copy">
            <strong>SuoCode</strong>
            <span>Local agent</span>
          </div>
          <button className="icon-button" type="button" aria-label="Settings">
            <Settings size={17} strokeWidth={1.7} />
          </button>
        </div>
      </aside>

      <section className="conversation-pane">
        <header className="conversation-header window-drag">
          {!leftOpen ? (
            <button
              className="icon-button no-drag"
              type="button"
              aria-label="Show sidebar"
              onClick={() => setLeftOpen(true)}
            >
              <PanelLeft size={17} />
            </button>
          ) : null}
          <div className="conversation-title">
            <strong>{activeConversation?.title ?? "New chat"}</strong>
            {project ? <span>{project.name}</span> : null}
          </div>
          {!rightOpen ? (
            <button
              className="icon-button no-drag header-right-toggle"
              type="button"
              aria-label="Show project inspector"
              onClick={() => setRightOpen(true)}
            >
              <PanelRight size={17} />
            </button>
          ) : null}
        </header>

        <div className="conversation-body">
          {activeConversation ? (
            <article className="prompt-card">
              <p>{activeConversation.title}</p>
            </article>
          ) : (
            <div className="empty-chat">
              <div className="empty-chat-mark">S</div>
              <h1>What do you want to build?</h1>
              <p>
                {project
                  ? `SuoCode is ready in ${project.name}.`
                  : "Open a project to start a new agent session."}
              </p>
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <form className="composer" onSubmit={submitPrompt}>
            <textarea
              ref={inputRef}
              value={draft}
              rows={2}
              aria-label="Message SuoCode"
              placeholder={project ? "Ask SuoCode to work on this project" : "Open a project to begin"}
              disabled={!project}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="composer-toolbar">
              <span className="agent-mode">
                <CircleDot size={13} />
                Agent
              </span>
              <button
                className="send-button"
                type="submit"
                aria-label="Send message"
                disabled={!project || !draft.trim()}
              >
                <ArrowUp size={17} strokeWidth={2.2} />
              </button>
            </div>
          </form>
          <div className="workspace-status">
            <span>
              <FileCode2 size={14} />
              {project?.path ?? "No project selected"}
            </span>
          </div>
        </div>
      </section>

      <aside className="inspector-pane">
        <div className="inspector-header window-drag">
          <span>On project</span>
          <button
            className="icon-button no-drag"
            type="button"
            aria-label="Hide project inspector"
            onClick={() => setRightOpen(false)}
          >
            <PanelRight size={17} />
          </button>
        </div>

        <nav className="inspector-nav" aria-label="Project tools">
          {inspectorItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={item.id === inspectorView ? "active" : ""}
                type="button"
                key={item.id}
                onClick={() => setInspectorView(item.id)}
              >
                <Icon size={17} strokeWidth={1.7} />
                <span>{item.label}</span>
                {item.meta ? <small>{item.meta}</small> : null}
              </button>
            );
          })}
        </nav>

        <section className="inspector-content">
          {inspectorView === "files" && project ? (
            <div className="file-root">
              <Folder size={16} />
              <div>
                <strong>{project.name}</strong>
                <span>{project.path}</span>
              </div>
            </div>
          ) : (
            <EmptyInspector view={inspectorView} />
          )}
        </section>
      </aside>
    </main>
  );
}

