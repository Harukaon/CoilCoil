import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { diagnostics } from "../diagnostics";

interface AppErrorBoundaryState {
  error?: Error;
}

/**
 * The last stop between a render that threw and a blank window.
 *
 * React unmounts the whole tree when a render throws, so without this the
 * symptom is an empty window and no record of what happened — the least
 * reportable failure the app has. Here it becomes a screen that names the
 * error and hands over the log, which is the difference between "它白屏了"
 * and a stack someone can act on.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    diagnostics.error("react", "render_failed", error, { componentStack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-crash">
        <h1>界面出错了</h1>
        <p>这一次渲染失败了，详细信息已经写进日志。把日志发给开发者就能定位。</p>
        <pre className="app-crash-detail">{error.stack ?? error.message}</pre>
        <div className="app-crash-actions">
          <button
            type="button"
            onClick={() => {
              diagnostics.flush();
              void window.coilcoil.revealDiagnostics();
            }}
          >
            打开日志所在文件夹
          </button>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </div>
    );
  }
}
