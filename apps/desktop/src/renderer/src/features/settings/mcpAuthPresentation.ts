import type { McpActionResult, McpServerRuntimeStatus } from "@coilcoil/runtime-protocol";

/**
 * 检查状态失败之后，该不该把用户直接接到重新授权上。
 *
 * 判断依据是「服务器有没有答话」，不是它答了什么。答了话就说明它活着，那连不上的
 * 嫌疑就落在手里这份登录凭据上——这个推理对任何状态码都成立，包括写错的那些。
 *
 * 2026-09-14 遇到的那台 MCP Server 就把过期令牌报成了 500。按状态码认，我们只当成
 * 「服务器炸了」，界面上给一句连不上就没了下文；用户唯一的出路是去文件系统里手动
 * 删掉本地凭据。按「答没答话」认就不会被骗：500 也好 502 也好，它答了，那就去重新
 * 登录一次试试。
 *
 * 反过来，压根没连上（拒绝连接、DNS、超时）是没有状态码的，那时候弹一个浏览器出来
 * 毫无意义——服务器不在，登录也登不了。那种情况仍然只报错误。
 */
export function failureNeedsReauthorization(
  entry: Pick<McpServerRuntimeStatus, "failureHttpStatus"> | undefined,
  supportsAuth: boolean,
): boolean {
  if (!supportsAuth) return false;
  return typeof entry?.failureHttpStatus === "number";
}

/**
 * Where a single MCP OAuth attempt has got to.
 *
 * `waiting` is the state that used to have no representation at all: the old
 * panel opened a browser, showed a paste box and then said nothing, so a user
 * who had finished logging in had no way to tell whether the app was still
 * listening. Every step now has a name, and the two ends — `succeeded` and
 * `failed` — are what the dialog reports back.
 */
export type McpAuthPhase = "starting" | "waiting" | "completing" | "succeeded" | "failed";

export interface McpAuthFlowState {
  server: string;
  phase: McpAuthPhase;
  /** The authorization page, kept so it can be reopened. */
  authorizationUrl?: string;
  /** Whether the runtime is holding the loopback redirect for this attempt. */
  awaitingCallback: boolean;
  /** What to tell the user about the current phase, when it is not the default. */
  message?: string;
}

function detailString(result: McpActionResult, key: string): string | undefined {
  const value = result.details?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function mcpAuthFlowStarted(server: string): McpAuthFlowState {
  return { server, phase: "starting", awaitingCallback: false };
}

/**
 * Read what `start_mcp_auth` came back with.
 *
 * The extension answers in one of three shapes: a refusal, an
 * already-authenticated server, or an authorization URL plus whether the
 * redirect will be captured automatically.
 */
export function mcpAuthFlowFromStart(state: McpAuthFlowState, result: McpActionResult): McpAuthFlowState {
  const error = detailString(result, "error");
  if (error) {
    return { ...state, phase: "failed", message: detailString(result, "message") ?? result.text ?? error };
  }
  if (result.details?.authenticated === true) {
    return { ...state, phase: "succeeded", message: `${state.server} 已经完成认证。` };
  }
  const authorizationUrl = detailString(result, "authorizationUrl");
  if (!authorizationUrl) {
    return { ...state, phase: "failed", message: result.text || "MCP 扩展没有返回授权地址。" };
  }
  return {
    ...state,
    phase: "waiting",
    authorizationUrl,
    awaitingCallback: result.details?.awaitingCallback === true,
  };
}

/**
 * 浏览器那一半结束了，剩下的是换令牌和重连。
 *
 * 这一档以前没人切：一次请求从「打开浏览器」一直等到「服务器重连完、工具列完」，
 * 中途界面一个字不变，于是浏览器早就回调完了，对话框还挂着「等待浏览器完成授权
 * …」。用户只能猜是不是没收到。
 */
export function mcpAuthFlowCallbackReceived(state: McpAuthFlowState): McpAuthFlowState {
  return { ...state, phase: "completing", message: undefined };
}

export function mcpAuthFlowFailed(state: McpAuthFlowState, error: unknown): McpAuthFlowState {
  const message = error instanceof Error ? error.message : String(error);
  return { ...state, phase: "failed", message };
}

export function mcpAuthFlowSucceeded(state: McpAuthFlowState, result: McpActionResult): McpAuthFlowState {
  return { ...state, phase: "succeeded", message: result.text || `${state.server} 已完成认证。` };
}

export function mcpAuthTitle(state: McpAuthFlowState): string {
  if (state.phase === "succeeded") return "认证成功";
  if (state.phase === "failed") return "认证失败";
  return `认证 ${state.server}`;
}

export function mcpAuthDescription(state: McpAuthFlowState): string {
  if (state.message) return state.message;
  if (state.phase === "starting") return "正在向 MCP 扩展申请授权地址，稍后会自动打开浏览器。";
  if (state.phase === "completing") return "浏览器已经回来了。正在用授权码换取访问令牌，然后重新连接这台服务器并读取它的工具。";
  if (state.phase === "waiting") {
    return state.awaitingCallback
      ? "已经打开浏览器。请在浏览器里登录并同意授权，完成后回到这里——CoilCoil 会自动收到回调并完成认证。"
      : "已经打开浏览器。这个服务器无法自动回调，请在登录后把浏览器地址栏里的完整回调地址粘贴到下面。";
  }
  if (state.phase === "succeeded") return `${state.server} 已完成认证。`;
  return "授权没有完成。";
}

/** A flow is over once it has reported success or failure. */
export function mcpAuthTerminal(state: McpAuthFlowState): boolean {
  return state.phase === "succeeded" || state.phase === "failed";
}

/**
 * Whether to offer the paste box.
 *
 * It is the fallback for the servers whose redirect never reaches the local
 * listener, so it is offered exactly when waiting without a captured callback,
 * or after something went wrong — never as the primary path.
 */
export function mcpAuthManualFallbackVisible(state: McpAuthFlowState): boolean {
  if (state.phase === "failed") return Boolean(state.authorizationUrl);
  return state.phase === "waiting" && !state.awaitingCallback;
}
