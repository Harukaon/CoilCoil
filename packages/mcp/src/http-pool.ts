/**
 * One kept-alive connection per MCP server.
 *
 * Node's global fetch pools connections, but not for long enough and not in a
 * way we control, and the cost of getting that wrong is not subtle. Measured on
 * a machine behind a local proxy: the TLS handshake to an MCP server takes
 * **five seconds**, while a request on an already-open connection takes 0.3.
 * Reopening per request turned a status check into fifteen seconds and made
 * every single tool call the Agent issued cost another five.
 *
 * So each connection gets its own agent, held open long enough that a
 * conversation's worth of tool calls share one handshake, and destroyed with
 * the connection so nothing is left holding a socket.
 *
 * The proxy has to be honoured while doing it. CoilCoil's main process resolves
 * the system proxy and passes it to the runtime as `HTTPS_PROXY` with
 * `NODE_USE_ENV_PROXY=1`; a plain `Agent` would quietly ignore that and go
 * direct, which for anyone who actually needs the proxy is not slowness but
 * failure. `EnvHttpProxyAgent` reads the same variables — including `NO_PROXY`,
 * which is what keeps loopback traffic off the proxy.
 */
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

/**
 * How long an idle connection is kept.
 *
 * Generous on purpose: the thing being avoided costs five seconds, and an idle
 * socket costs nothing but a file descriptor. Anything shorter than a pause in
 * the conversation defeats the point.
 */
const KEEP_ALIVE_MS = 5 * 60_000;
/** A ceiling in case a server advertises an absurd keep-alive of its own. */
const KEEP_ALIVE_MAX_MS = 10 * 60_000;

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

function proxyConfigured(environment: Record<string, string | undefined>): boolean {
  return PROXY_VARIABLES.some((name) => (environment[name] ?? "").trim());
}

export interface McpHttpPool {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

/**
 * Build the fetch one MCP connection should use.
 *
 * Returned rather than installed globally: MCP servers are not the only thing
 * this process talks to, and a five-minute keep-alive is the right answer for a
 * handful of long-lived server connections, not for everything.
 */
export function createHttpPool(environment: Record<string, string | undefined> = process.env): McpHttpPool {
  const options = {
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
    // A handful is plenty: the streamable-HTTP transport holds one connection
    // open for the event stream and sends requests over the others.
    connections: 4,
  };
  const dispatcher: Dispatcher = proxyConfigured(environment)
    ? new EnvHttpProxyAgent(options)
    : new Agent(options);
  const pooledFetch = (
    input: Parameters<typeof undiciFetch>[0],
    init?: Parameters<typeof undiciFetch>[1],
  ): ReturnType<typeof undiciFetch> => undiciFetch(input, { ...init, dispatcher });
  return {
    fetch: pooledFetch as unknown as typeof globalThis.fetch,
    close: async () => { await dispatcher.destroy(); },
  };
}
