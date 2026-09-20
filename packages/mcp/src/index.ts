/**
 * CoilCoil's own MCP client.
 *
 * It exists to replace pi-mcp-adapter, which CoilCoil only ever used a fraction
 * of and paid for in three ways the user could feel: a macOS keychain dialog on
 * every rebuild, a metadata bootstrap and proxy-tool hop on every call, and — the
 * one that made the settings panel unusable — the fact that it lived inside a Pi
 * session, so nothing about MCP could be inspected until a conversation was
 * open. Owning this layer fixes all three at their root rather than working
 * around them in the interface.
 *
 * The protocol itself is not reimplemented: the official SDK does transports,
 * the handshake and the OAuth dance. What is ours is where credentials are kept
 * and who is allowed to ask.
 */
export {
  McpCredentialStore,
  credentialKey,
  defaultCredentialFile,
  type McpCredentialRecord,
} from "./credential-store.js";
export { McpOAuthProvider, type McpOAuthOptions } from "./oauth-provider.js";
export type { McpDiagnosticLevel, McpDiagnosticLogger } from "./diagnostic.js";
export {
  expandPlaceholders,
  launchFor,
  missingPlaceholders,
  type EnvironmentSource,
  type HttpLaunch,
  type McpLaunch,
  type StdioLaunch,
} from "./definition.js";
export {
  McpAuthCallbackServer,
  type McpAuthCallback,
} from "./auth-callback.js";
export {
  McpManager,
  authorizationCode,
  authorizationState,
  type McpAuthStart,
  type McpManagerOptions,
} from "./manager.js";
export {
  McpConnection,
  type McpConnectionOptions,
  type McpConnectionStatus,
  type McpResourceSummary,
  type McpToolSummary,
} from "./connection.js";
