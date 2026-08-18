import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { LoaderCircle, Play, Square, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalSessionSnapshot } from "../../../../shared/desktop-api";
import { toastError } from "../../ui/toast";
import "./terminal.css";

const MAX_TERMINAL_OUTPUT = 500_000;

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
        background: "#171816",
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
  const session = useMemo(() => sessions.filter((item) => item.cwd === cwd).at(-1), [cwd, sessions]);

  const create = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setSessions(await window.suocode.createTerminal(cwd));
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
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
    void window.suocode.getTerminalSessions().then(async (current) => {
      if (!mounted) return;
      setSessions(current);
      if (!current.some((item) => item.cwd === cwd && item.status === "running")) await create();
      else setLoading(false);
    }).catch((error: unknown) => {
      if (mounted) toastError(error instanceof Error ? error.message : String(error));
      setLoading(false);
    });
    return () => {
      mounted = false;
      unsubscribeState();
      unsubscribeData();
    };
  }, [create, cwd]);

  const stop = async (): Promise<void> => {
    if (!session) return;
    try {
      setSessions(await window.suocode.closeTerminal(session.id));
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!session) {
    return <div className="terminal-empty"><TerminalIcon size={24} /><strong>{loading ? "正在连接终端…" : "终端已关闭"}</strong>{loading ? <LoaderCircle className="spin" size={14} /> : <button type="button" onClick={() => void create()}><Play size={12} />新建终端</button>}</div>;
  }

  return (
    <section className="terminal-panel">
      <header className="terminal-header">
        <div><TerminalIcon size={14} /><strong>终端</strong><span title={session.cwd}>{session.cwd}</span></div>
        <div className="terminal-header-actions">
          <span className={session.status === "running" ? "terminal-running" : "terminal-exited"}>{session.status === "running" ? "运行中" : `已退出 ${session.exitCode ?? ""}`}</span>
          {session.status === "running" ? <button type="button" aria-label="结束终端" title="结束终端" onClick={() => void stop()}><Square size={12} /></button> : <button type="button" aria-label="新建终端" title="新建终端" onClick={() => void create()}><Play size={12} /></button>}
        </div>
      </header>
      <TerminalSurface session={session} active={active} />
    </section>
  );
}
