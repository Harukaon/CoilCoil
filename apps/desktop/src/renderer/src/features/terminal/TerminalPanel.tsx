import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { LoaderCircle, Play, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSessionSnapshot } from "../../../../shared/desktop-api";
import { toastError } from "../../ui/toast";
import { openTerminalSession } from "./terminalSessions";
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
    const input = terminal.onData((data) => { void window.coilcoil.writeTerminal(session.id, data); });
    const observer = new ResizeObserver(() => {
      if (!activeRef.current || container.clientWidth < 20 || container.clientHeight < 20) return;
      window.requestAnimationFrame(() => {
        try {
          fit.fit();
          void window.coilcoil.resizeTerminal(session.id, terminal.cols, terminal.rows);
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
          void window.coilcoil.resizeTerminal(session.id, terminal.cols, terminal.rows);
          terminal.focus();
        }
      } catch {
        // A just-hidden inspector has no measurable geometry.
      }
    });
  }, [active, session.id]);

  return <div className="terminal-surface" ref={containerRef} />;
}

export function TerminalPanel({ sessionId, cwd, active, onSessionOpened }: {
  sessionId: string;
  cwd: string;
  active: boolean;
  onSessionOpened(id: string): void;
}): React.JSX.Element {
  const [session, setSession] = useState<TerminalSessionSnapshot>();
  const [loading, setLoading] = useState(true);

  // Each panel tracks only its own shell. The store publishes every session on
  // every change, and a panel per tab that kept the whole list would hold one
  // copy of every buffer and re-render on data meant for another tab.
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    const unsubscribeState = window.coilcoil.onTerminalStateUpdated((next) => {
      if (mounted) setSession(next.find((item) => item.id === sessionId));
    });
    const unsubscribeData = window.coilcoil.onTerminalData(({ id, data }) => {
      if (!mounted || id !== sessionId) return;
      setSession((current) => current && { ...current, output: `${current.output}${data}`.slice(-MAX_TERMINAL_OUTPUT) });
    });
    void window.coilcoil.getTerminalSessions().then((current) => {
      if (!mounted) return;
      setSession(current.find((item) => item.id === sessionId));
      setLoading(false);
    }).catch((error: unknown) => {
      if (!mounted) return;
      toastError(error instanceof Error ? error.message : String(error));
      setLoading(false);
    });
    return () => {
      mounted = false;
      unsubscribeState();
      unsubscribeData();
    };
  }, [sessionId]);

  const reopen = useCallback(async (): Promise<void> => {
    try {
      const opened = await openTerminalSession(cwd);
      if (opened) onSessionOpened(opened);
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    }
  }, [cwd, onSessionOpened]);

  if (!session) {
    return (
      <div className="terminal-empty">
        <TerminalIcon size={24} />
        <strong>{loading ? "正在连接终端…" : "终端已关闭"}</strong>
        {loading
          ? <LoaderCircle className="spin" size={14} />
          : <button type="button" onClick={() => void reopen()}><Play size={12} />新建终端</button>}
      </div>
    );
  }

  return (
    <section className="terminal-panel">
      <TerminalSurface session={session} active={active} />
      {session.status === "exited" ? (
        <footer className="terminal-exit-bar">
          <span>{`shell 已退出${session.exitCode === undefined ? "" : `（代码 ${session.exitCode}）`}`}</span>
          <button type="button" onClick={() => void reopen()}><Play size={11} />重新打开</button>
        </footer>
      ) : null}
    </section>
  );
}
