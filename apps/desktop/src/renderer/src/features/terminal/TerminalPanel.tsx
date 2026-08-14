import { LoaderCircle, Square, Terminal as TerminalIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalSessionSnapshot } from "../../../../shared/desktop-api";

export function TerminalPanel({ session, onWrite, onClose }: {
  session: TerminalSessionSnapshot;
  onWrite: (data: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const outputRef = useRef<HTMLPreElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [session.output]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      const cols = Math.max(20, Math.floor(rect.width / 8));
      const rows = Math.max(4, Math.floor(rect.height / 18));
      void window.suocode.resizeTerminal(session.id, cols, rows);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    return () => observer.disconnect();
  }, [session.id]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!draft || session.status !== "running") return;
    onWrite(`${draft}\r`);
    setDraft("");
  };

  return (
    <section className="terminal-panel" ref={hostRef}>
      <header className="terminal-header">
        <div><TerminalIcon size={14} /><strong>终端</strong><span title={session.cwd}>{session.cwd}</span></div>
        <div className="terminal-header-actions">
          {session.status === "running" ? <span className="terminal-running"><LoaderCircle className="spin" size={11} />运行中</span> : <span className="terminal-exited">已退出</span>}
          <button type="button" aria-label="关闭终端" title="关闭终端" onClick={onClose}><Square size={12} /></button>
        </div>
      </header>
      <pre className="terminal-output" ref={outputRef}>{session.output || "连接本地终端…"}</pre>
      <form className="terminal-input" onSubmit={submit}>
        <span aria-hidden="true">❯</span>
        <input
          aria-label="终端输入"
          value={draft}
          disabled={session.status !== "running"}
          placeholder={session.status === "running" ? "输入命令并回车" : "终端已退出"}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
    </section>
  );
}
