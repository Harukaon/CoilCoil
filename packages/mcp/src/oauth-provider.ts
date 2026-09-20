/**
 * CoilCoil's side of an MCP server's OAuth flow.
 *
 * The MCP SDK does the protocol — metadata discovery, dynamic client
 * registration, PKCE, the token exchange and refresh — and asks an
 * `OAuthClientProvider` for exactly two things: where to keep the credentials,
 * and how to put a browser in front of the user. This is that seam, and it is
 * the whole reason replacing pi-mcp-adapter gets rid of the keychain dialog:
 * storage is ours to choose, so it goes in CoilCoil's own file (see
 * `credential-store.ts`) rather than the login keychain.
 *
 * One instance serves one server. Tokens, client registrations and PKCE
 * verifiers must not cross between servers, and keying the store by the
 * server's address rather than by this object is what keeps that true across
 * restarts.
 */
import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentialKey, type McpCredentialStore } from "./credential-store.js";
import type { McpDiagnosticLogger } from "./diagnostic.js";

export interface McpOAuthOptions {
  /** The MCP server this authorization belongs to. */
  serverUrl: string;
  store: McpCredentialStore;
  /** Where the authorization server sends the browser back to. */
  redirectUrl: string;
  /**
   * Hand the authorization page to the user.
   *
   * Kept as a callback because who opens it differs by caller: the desktop app
   * sends it to the system browser, and a test just records it.
   */
  openAuthorization: (url: URL) => void | Promise<void>;
  /** Shown on the authorization server's consent screen. */
  clientName?: string;
  clientUri?: string;
  /** Optional sink for redacted authentication lifecycle diagnostics. */
  diagnostic?: McpDiagnosticLogger;
}

const DEFAULT_CLIENT_NAME = "CoilCoil";
const DEFAULT_CLIENT_URI = "https://github.com/Harukaon/CoilCoil";

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly key: string;
  /** The authorization page for the attempt in flight, for a retry to reopen. */
  private lastAuthorizationUrl?: URL;

  constructor(private readonly options: McpOAuthOptions) {
    this.key = credentialKey(options.serverUrl);
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName ?? DEFAULT_CLIENT_NAME,
      client_uri: this.options.clientUri ?? DEFAULT_CLIENT_URI,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /**
   * The `state` this attempt runs under.
   *
   * It is also the key the loopback listener files the redirect under, so it is
   * persisted rather than generated per call: the browser comes back in a
   * different turn, and a `state` that had only ever existed in memory would no
   * longer match if the flow were resumed.
   */
  state(): string {
    const existing = this.options.store.get(this.key)?.state;
    if (existing) return existing;
    const next = randomUUID();
    this.options.store.update(this.key, { url: this.options.serverUrl, state: next });
    return next;
  }

  /**
   * 之前动态注册下来的 client，前提是它注册的回调地址还是我们现在这一个。
   *
   * 回调监听器按 7842、7843、7844… 依次找空位，所以某次授权可能是在 7843 上注册
   * 的；等端口腾出来、这次回到 7842，再拿那个旧 client_id 去发起授权，授权服务器
   * 只会回一句「redirect_uri 与注册时不一致」——而且会一直这样，因为我们每次都把
   * 那份过期的注册信息原样拿出来用。
   *
   * 对不上就当作没注册过，让 SDK 重新做一次动态注册，把当前地址注册进去。服务器
   * 没回 redirect_uris 的情况不判断：那是它没告诉我们，不是对不上。
   */
  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = this.options.store.get(this.key)?.clientInformation as OAuthClientInformationMixed | undefined;
    if (!stored) return undefined;
    const registered = (stored as { redirect_uris?: unknown }).redirect_uris;
    if (!Array.isArray(registered) || registered.length === 0) return stored;
    return registered.includes(this.options.redirectUrl) ? stored : undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.options.store.update(this.key, {
      url: this.options.serverUrl,
      clientInformation: clientInformation as unknown as OAuthClientInformationFull,
    });
  }

  tokens(): OAuthTokens | undefined {
    return this.options.store.get(this.key)?.tokens as OAuthTokens | undefined;
  }

  private tokenSummary(tokens: OAuthTokens): Record<string, unknown> {
    const value = tokens as OAuthTokens & { expires_in?: unknown; scope?: unknown; token_type?: unknown };
    return {
      hasAccessToken: typeof value.access_token === "string" && value.access_token.length > 0,
      hasRefreshToken: typeof value.refresh_token === "string" && value.refresh_token.length > 0,
      expiresIn: typeof value.expires_in === "number" ? value.expires_in : undefined,
      hasScope: typeof value.scope === "string" && value.scope.length > 0,
      tokenType: typeof value.token_type === "string" ? value.token_type : undefined,
    };
  }

  /**
   * Keep what came back from the token endpoint.
   *
   * The PKCE verifier and the `state` are spent at this point and are dropped
   * in the same write: leaving them behind would let a replayed redirect be
   * accepted against a flow that has already finished.
   */
  saveTokens(tokens: OAuthTokens): void {
    this.options.store.update(this.key, {
      url: this.options.serverUrl,
      tokens: tokens as unknown as Record<string, unknown>,
      codeVerifier: undefined,
      state: undefined,
    });
    this.options.diagnostic?.("info", "oauth_tokens_saved", this.tokenSummary(tokens));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.lastAuthorizationUrl = authorizationUrl;
    this.options.diagnostic?.("info", "oauth_authorization_started", {
      hasState: Boolean(authorizationUrl.searchParams.get("state")),
    });
    await this.options.openAuthorization(authorizationUrl);
  }

  /** The page the browser was sent to, so the panel can offer to reopen it. */
  get authorizationUrl(): URL | undefined {
    return this.lastAuthorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.options.store.update(this.key, { url: this.options.serverUrl, codeVerifier });
    this.options.diagnostic?.("info", "oauth_authorization_prepared");
  }

  codeVerifier(): string {
    const stored = this.options.store.get(this.key)?.codeVerifier;
    if (!stored) throw new Error("这次授权的校验码已经不在了，请重新发起认证。");
    return stored;
  }

  /**
   * Throw away what the server says is no longer good.
   *
   * The SDK calls this when it is told a credential is stale, and honouring it
   * is what keeps an expired registration from being retried forever. `all` is
   * also what 登出 goes through, so it clears the record outright rather than
   * leaving a registration the user believes they discarded.
   */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    this.options.diagnostic?.("warn", "oauth_credentials_invalidated", { scope });
    if (scope === "all") {
      this.options.store.clear(this.key);
      return;
    }
    if (scope === "discovery") return;
    const patch = {
      client: { clientInformation: undefined },
      tokens: { tokens: undefined },
      verifier: { codeVerifier: undefined, state: undefined },
    }[scope];
    this.options.store.update(this.key, patch);
  }
}
