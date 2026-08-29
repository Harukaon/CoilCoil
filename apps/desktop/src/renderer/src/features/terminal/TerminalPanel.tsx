import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { LoaderCircle, Play, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSessionSnapshot } from "../../../../shared/desktop-api";
import { storedMonoFontStack } from "../../theme";
import { toastError } from "../../ui/toast";
import { openTerminalSession } from "./terminalSessions";
import { TerminalStream } from "./terminalStream";
import "./terminal.css";

const TERMINAL_BACKGROUND = "#2b2b29";

function TerminalSurface({ session, stream, active }: {
  session: TerminalSessionSnapshot;
  stream: TerminalStream;
  active: boolean;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | undefined>(undefined);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  /**
   * Tell the pty about a size xterm has actually taken.
   *
   * Every resize makes a full-screen TUI redraw, so sending one per animation
   * frame while a pane is being dragged interleaves half-drawn frames at
   * different widths. Only a size that really changed is worth a round trip.
   */
  const publishSize = useCallback((terminal: XTerm): void => {
    const last = sizeRef.current;
    if (last && last.cols === terminal.cols && last.rows === terminal.rows) return;
    sizeRef.current = { cols: terminal.cols, rows: terminal.rows };
    void window.coilcoil.resizeTerminal(session.id, terminal.cols, terminal.rows);
  }, [session.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new XTerm({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      // 外观设置里选的等宽字体。xterm 不继承 CSS，字体栈只能直接交给它；
      // 已经开着的终端要重新打开才会换过来。
      fontFamily: storedMonoFontStack(),
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
    // The snapshot is the tail main kept for exactly this moment. Everything
    // after it arrives as a data event and is written as it comes, so xterm
    // owns the scrollback from here on and is never reset out from under a
    // reader who has scrolled up.
    terminal.write(session.output);
    const sink = { write: (data: string) => terminal.write(data) };
    stream.attach(sink);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => { void window.coilcoil.writeTerminal(session.id, data); });
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!activeRef.current || container.clientWidth < 20 || container.clientHeight < 20) return;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        try {
          fit.fit();
          publishSize(terminal);
        } catch {
          // The inspector can become hidden before the queued frame runs.
        }
      });
    });
    observer.observe(container);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      stream.detach(sink);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      sizeRef.current = undefined;
    };
  }, [session.id, stream, publishSize]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const terminal = terminalRef.current;
        if (!terminal) return;
        publishSize(terminal);
        // A hidden tab is `display: none`, so the rows written while it was
        // away were laid out against no geometry. Repaint the viewport once on
        // the way back in rather than waiting for the next chunk of output.
        terminal.refresh(0, terminal.rows - 1);
        terminal.focus();
      } catch {
        // A just-hidden inspector has no measurable geometry.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, publishSize]);

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
  // One pump per shell: it holds whatever arrives between subscribing and the
  // xterm being open, and hands every later chunk straight to it. A ref rather
  // than a memo because dropping it would restart the terminal.
  const streamRef = useRef<{ id: string; stream: TerminalStream } | undefined>(undefined);
  if (streamRef.current?.id !== sessionId) streamRef.current = { id: sessionId, stream: new TerminalStream() };
  const { stream } = streamRef.current;

  // Each panel tracks only its own shell. The store publishes every session on
  // every change, and a panel per tab that kept the whole list would hold one
  // copy of every buffer and re-render on data meant for another tab. Output
  // never becomes React state at all — it goes to xterm, which is the only
  // thing that has to remember it.
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    const unsubscribeState = window.coilcoil.onTerminalStateUpdated((next) => {
      if (mounted) setSession(next.find((item) => item.id === sessionId));
    });
    const unsubscribeData = window.coilcoil.onTerminalData(({ id, data }) => {
      if (!mounted || id !== sessionId) return;
      stream.push(data);
    });
    void window.coilcoil.getTerminalSessions().then((current) => {
      if (!mounted) return;
      stream.discardPending();
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
  }, [sessionId, stream]);

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
      <TerminalSurface session={session} stream={stream} active={active} />
      {session.status === "exited" ? (
        <footer className="terminal-exit-bar">
          <span>{`shell 已退出${session.exitCode === undefined ? "" : `（代码 ${session.exitCode}）`}`}</span>
          <button type="button" onClick={() => void reopen()}><Play size={11} />重新打开</button>
        </footer>
      ) : null}
    </section>
  );
}
