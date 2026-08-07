import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Bot, Code2, PanelLeft, PanelRight, Plus, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopTerminalSession, ProjectSelection, TerminalLaunchKind } from "../../../../shared/desktop-api";
import "./terminal.css";

const autoStartedProjects = new Set<string>();

function upsertSession(sessions: DesktopTerminalSession[], session: DesktopTerminalSession): DesktopTerminalSession[] {
  const index = sessions.findIndex((item) => item.id === session.id);
  if (index < 0) return [...sessions, session];
  const next = [...sessions];
  next[index] = session;
  return next;
}

function launchLabel(kind: TerminalLaunchKind): string {
  if (kind === "pi") return "SuoCode Pi";
  if (kind === "claude") return "Claude Code";
  if (kind === "codex") return "Codex";
  return "终端";
}

function TerminalSurface({ session, active }: { session: DesktopTerminalSession; active: boolean }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.28,
      scrollback: 10_000,
      theme: {
        background: "#171715",
        foreground: "#deded8",
        cursor: "#deded8",
        selectionBackground: "#57574f",
        black: "#292927",
        red: "#d06a61",
        green: "#7eab75",
        yellow: "#c7a55b",
        blue: "#7391b9",
        magenta: "#a786ad",
        cyan: "#6fa8a1",
        white: "#deded8",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.write(session.buffer);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => { void window.suocode.writeTerminal(session.id, data); });
    const unsubscribe = window.suocode.onTerminalEvent((event) => {
      if (event.type === "data" && event.id === session.id) terminal.write(event.data);
    });
    const observer = new ResizeObserver(() => {
      if (!activeRef.current || !container.isConnected || container.clientWidth < 20 || container.clientHeight < 20) return;
      window.requestAnimationFrame(() => {
        try {
          fit.fit();
          void window.suocode.resizeTerminal(session.id, terminal.cols, terminal.rows);
        } catch {
          // The surface can be hidden between the observer callback and fitting.
        }
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      unsubscribe();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    if (!active) return;
    window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const terminal = terminalRef.current;
        if (terminal) {
          void window.suocode.resizeTerminal(session.id, terminal.cols, terminal.rows);
          terminal.focus();
        }
      } catch {
        // A just-hidden panel has no measurable geometry.
      }
    });
  }, [active, session.id]);

  return <div className={`terminal-surface ${active ? "active" : ""}`} aria-hidden={!active} ref={containerRef} />;
}

export function TerminalWorkspace({ project, leftOpen, rightOpen, onOpenLeft, onOpenRight }: {
  project: ProjectSelection;
  leftOpen: boolean;
  rightOpen: boolean;
  onOpenLeft: () => void;
  onOpenRight: () => void;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<DesktopTerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [creating, setCreating] = useState<TerminalLaunchKind>();
  const [error, setError] = useState<string>();
  const projectSessions = useMemo(() => sessions.filter((session) => session.cwd === project.path), [project.path, sessions]);

  const create = useCallback(async (kind: TerminalLaunchKind): Promise<void> => {
    setCreating(kind);
    setError(undefined);
    try {
      const session = await window.suocode.createTerminal({ cwd: project.path, kind });
      setSessions((current) => upsertSession(current, session));
      setActiveId(session.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(undefined);
    }
  }, [project.path]);

  useEffect(() => {
    let disposed = false;
    void window.suocode.listTerminals().then((listed) => {
      if (disposed) return;
      setSessions(listed);
      const current = listed.find((session) => session.cwd === project.path);
      if (current) {
        setActiveId((value) => listed.some((session) => session.id === value) ? value : current.id);
        return;
      }
      if (!autoStartedProjects.has(project.path)) {
        autoStartedProjects.add(project.path);
        void create("shell");
      }
    }).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    const unsubscribe = window.suocode.onTerminalEvent((event) => {
      if (event.type === "created") setSessions((current) => upsertSession(current, event.session));
      if (event.type === "exit") setSessions((current) => current.map((session) => session.id === event.id ? { ...session, running: false, exitCode: event.exitCode, signal: event.signal } : session));
      if (event.type === "closed") {
        setSessions((current) => current.filter((session) => session.id !== event.id));
        setActiveId((current) => current === event.id ? undefined : current);
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [create, project.path]);

  useEffect(() => {
    if (activeId && projectSessions.some((session) => session.id === activeId)) return;
    setActiveId(projectSessions.at(-1)?.id);
  }, [activeId, projectSessions]);

  const close = async (id: string): Promise<void> => {
    await window.suocode.closeTerminal(id);
    setSessions((current) => current.filter((session) => session.id !== id));
  };

  return (
    <section className="terminal-workspace">
      <header className="terminal-workspace-header window-drag">
        {!leftOpen ? <button className="icon-button no-drag" type="button" aria-label="展开侧栏" onClick={onOpenLeft}><PanelLeft size={17} /></button> : null}
        <div className="terminal-workspace-title"><strong>终端</strong><span>{project.name}</span></div>
        <div className="terminal-launch-actions no-drag">
          <button type="button" disabled={Boolean(creating)} onClick={() => void create("shell")}><Plus size={13} />终端</button>
          <button type="button" disabled={Boolean(creating)} onClick={() => void create("claude")}><Bot size={13} />Claude Code</button>
          <button type="button" disabled={Boolean(creating)} onClick={() => void create("codex")}><Code2 size={13} />Codex</button>
          <button type="button" disabled={Boolean(creating)} onClick={() => void create("pi")}><SquareTerminal size={13} />SuoCode Pi</button>
          {!rightOpen ? <button className="icon-button" type="button" aria-label="展开右侧栏" onClick={onOpenRight}><PanelRight size={17} /></button> : null}
        </div>
      </header>
      <nav className="terminal-tabs">
        {projectSessions.map((session) => <div className={`terminal-tab ${session.id === activeId ? "active" : ""}`} key={session.id}><button className="terminal-tab-select" type="button" onClick={() => setActiveId(session.id)}><i className={session.running ? "running" : "exited"} /><span>{session.title}</span>{!session.running ? <small>{session.exitCode === 0 ? "已退出" : `退出 ${session.exitCode ?? ""}`}</small> : null}</button><button className="terminal-tab-close" type="button" aria-label={`关闭 ${session.title}`} onClick={() => void close(session.id)}><X size={11} /></button></div>)}
      </nav>
      <div className="terminal-stage">
        {projectSessions.map((session) => <TerminalSurface active={session.id === activeId} key={session.id} session={session} />)}
        {!projectSessions.length && !creating ? <div className="terminal-empty"><SquareTerminal size={22} /><strong>尚未打开终端</strong><p>新终端会在 {project.name} 中启动。</p><button type="button" onClick={() => void create("shell")}>打开终端</button></div> : null}
        {creating ? <div className="terminal-starting">正在启动 {launchLabel(creating)}…</div> : null}
        {error ? <div className="terminal-error">{error}<button type="button" onClick={() => setError(undefined)}><X size={12} /></button></div> : null}
      </div>
    </section>
  );
}
