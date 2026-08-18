import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { LoaderCircle, Play, Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalSessionSnapshot } from "../../../../shared/desktop-api";
import { toastError } from "../../ui/toast";
import "./terminal.css";

const MAX_TERMINAL_OUTPUT = 500_000;
const TERMINAL_BACKGROUND = "#2b2b29";

function TerminalSurface({ session, active }: { session: TerminalSessionSnapshot; active: boolean }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const renderedOutputRef = useRef("");
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new XTerm({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.28,
      scrollback: 10_000,
      theme: {
        background: TERMINAL_BACKGROUND,
        foreground: "#deded8",
        cursor: "#deded8",
        selectionBackground: "#57574f",
        black: "#3a3a37",
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
    terminal.write(session.output);
    renderedOutputRef.current = session.output;
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => { void window.suocode.writeTerminal(session.id, data); });
    const observer = new ResizeObserver(() => {
      if (!activeRef.current || container.clientWidth < 20 || container.clientHeight < 20) return;
      window.requestAnimationFrame(() => {
        try {
          fit.fit();
          void window.suocode.resizeTerminal(session.id, terminal.cols, terminal.rows);
        } catch {
          // The inspector can become hidden before the queued frame runs.
        }
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      renderedOutputRef.current = "";
    };
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || session.output === renderedOutputRef.current) return;
    const previous = renderedOutputRef.current;
    if (session.output.startsWith(previous)) terminal.write(session.output.slice(previous.length));
    else {
      terminal.reset();
      terminal.write(session.output);
    }
    renderedOutputRef.current = session.output;
  }, [session.output]);

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
        // A just-hidden inspector has no measurable geometry.
      }
    });
  }, [active, session.id]);

  return <div className="terminal-surface" ref={containerRef} />;
}

export function TerminalPanel({ cwd, active }: { cwd: string; active: boolean }): React.JSX.Element {
  const [sessions, setSessions] = useState<TerminalSessionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>();
  const workspaceSessions = useMemo(
    () => sessions.filter((item) => item.cwd === cwd).sort((left, right) => left.startedAt - right.startedAt),
    [cwd, sessions],
  );
  const session = workspaceSessions.find((item) => item.id === selectedId) ?? workspaceSessions.at(-1);

  const create = useCallback(async (): Promise<void> => {
    try {
      const next = await window.suocode.createTerminal(cwd);
      setSessions(next);
      // Selecting by identity rather than position: the state is workspace-wide,
      // so the newest shell for *this* cwd is the one that was just opened.
      const opened = next.filter((item) => item.cwd === cwd).sort((left, right) => left.startedAt - right.startedAt).at(-1);
      if (opened) setSelectedId(opened.id);
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    }
  }, [cwd]);

  useEffect(() => {
    let mounted = true;
    const unsubscribeState = window.suocode.onTerminalStateUpdated((next) => {
      if (mounted) setSessions(next);
    });
    const unsubscribeData = window.suocode.onTerminalData(({ id, data }) => {
      if (!mounted) return;
      setSessions((current) => current.map((item) => item.id === id
        ? { ...item, output: `${item.output}${data}`.slice(-MAX_TERMINAL_OUTPUT) }
        : item));
    });
    // `ensureTerminal` is idempotent in main, so a remount — including React's
    // double-invoked effects — cannot leave a second orphaned shell behind.
    void window.suocode.ensureTerminal(cwd).then((current) => {
      if (!mounted) return;
      setSessions(current);
      setLoading(false);
    }).catch((error: unknown) => {
      if (mounted) {
        toastError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
      unsubscribeState();
      unsubscribeData();
    };
  }, [cwd]);

  const close = async (id: string): Promise<void> => {
    try {
      const next = await window.suocode.closeTerminal(id);
      setSessions(next);
      if (id !== session?.id) return;
      const remaining = next.filter((item) => item.cwd === cwd).sort((left, right) => left.startedAt - right.startedAt);
      const closedIndex = workspaceSessions.findIndex((item) => item.id === id);
      setSelectedId((remaining[closedIndex] ?? remaining.at(-1))?.id);
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!session) {
    return (
      <div className="terminal-empty">
        <TerminalIcon size={24} />
        <strong>{loading ? "正在连接终端…" : "终端已关闭"}</strong>
        {loading
          ? <LoaderCircle className="spin" size={14} />
          : <button type="button" onClick={() => void create()}><Play size={12} />新建终端</button>}
      </div>
    );
  }

  return (
    <section className="terminal-panel">
      <div className="terminal-tabs" role="tablist" aria-label="终端">
        {workspaceSessions.map((item, index) => (
          <div
            className={`terminal-tab ${item.id === session.id ? "active" : ""} ${item.status === "exited" ? "exited" : ""}`}
            key={item.id}
          >
            <button
              type="button"
              role="tab"
              aria-selected={item.id === session.id}
              title={item.status === "exited" ? `已退出 ${item.exitCode ?? ""}`.trim() : item.cwd}
              onClick={() => setSelectedId(item.id)}
            >
              <TerminalIcon size={11} />
              <span>{index + 1}</span>
            </button>
            <button
              className="terminal-tab-close"
              type="button"
              aria-label={`关闭终端 ${index + 1}`}
              title="关闭终端"
              onClick={() => void close(item.id)}
            >
              <X size={10} />
            </button>
          </div>
        ))}
        <button className="terminal-tab-new" type="button" aria-label="新建终端" title="新建终端" onClick={() => void create()}>
          <Plus size={12} />
        </button>
      </div>
      {workspaceSessions.map((item) => (
        <div className={`terminal-stage ${item.id === session.id ? "active" : ""}`} key={item.id}>
          <TerminalSurface session={item} active={active && item.id === session.id} />
        </div>
      ))}
    </section>
  );
}
