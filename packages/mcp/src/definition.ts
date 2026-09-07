/**
 * Turning a saved MCP server entry into something a transport can be handed.
 *
 * Two jobs, both of which used to live inside pi-mcp-adapter where CoilCoil
 * could neither see nor test them.
 *
 * The first is placeholders. People paste configurations out of READMEs, and
 * those carry `${GITHUB_TOKEN}` rather than the secret itself — the whole point
 * being that the file can be shared and the value cannot. Both spellings in the
 * wild are honoured, `${VAR}` and PowerShell's `$env:VAR`. An unset variable
 * expands to nothing rather than being left as literal text: sending a header
 * that reads `Bearer ${GITHUB_TOKEN}` produces a puzzling 401 from the server,
 * while sending an empty one produces the honest "no credential" answer.
 *
 * The second is the bearer shortcut. `bearerTokenEnv` names an environment
 * variable holding a ready-made token, which is how most people authenticate a
 * corporate MCP server; it becomes an ordinary Authorization header, and an
 * explicit header of the user's own always wins over it.
 */
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)/g;

export type EnvironmentSource = Record<string, string | undefined>;

export function expandPlaceholders(value: string, environment: EnvironmentSource): string {
  return value.replace(PLACEHOLDER, (_match, braced: string | undefined, prefixed: string | undefined) => {
    const name = braced ?? prefixed ?? "";
    return environment[name] ?? "";
  });
}

function expandMap(
  values: Record<string, string>,
  environment: EnvironmentSource,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, expandPlaceholders(value, environment)]),
  );
}

/** Names referenced by a definition but missing from the environment. */
export function missingPlaceholders(
  server: McpServerConfiguration,
  environment: EnvironmentSource,
): string[] {
  const referenced = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(PLACEHOLDER)) referenced.add(match[1] ?? match[2]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) scan(item);
    }
  };
  scan([server.command, server.args, server.env, server.url, server.headers, server.cwd]);
  if (server.bearerTokenEnv?.trim()) referenced.add(server.bearerTokenEnv.trim());
  return [...referenced].filter((name) => !environment[name]).sort();
}

export interface StdioLaunch {
  kind: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface HttpLaunch {
  kind: "http";
  url: string;
  headers: Record<string, string>;
  /** Whether this server should go through the OAuth provider at all. */
  oauth: boolean;
}

export type McpLaunch = StdioLaunch | HttpLaunch;

/**
 * A stdio child inherits this process's environment plus the entry's own.
 *
 * Inheriting matters more than it looks: these servers are usually `npx`
 * wrappers that need PATH, HOME and the proxy variables to work at all, and a
 * clean environment turns every one of them into "command not found".
 */
export function launchFor(
  server: McpServerConfiguration,
  environment: EnvironmentSource,
): McpLaunch {
  if (server.transport === "stdio") {
    const command = expandPlaceholders(server.command?.trim() ?? "", environment);
    if (!command) throw new Error(`MCP Server「${server.name}」没有填启动命令。`);
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === "string") inherited[key] = value;
    }
    return {
      kind: "stdio",
      command,
      args: server.args.map((argument) => expandPlaceholders(argument, environment)),
      env: { ...inherited, ...expandMap(server.env, environment) },
      cwd: server.cwd ? expandPlaceholders(server.cwd, environment) : undefined,
    };
  }

  const url = expandPlaceholders(server.url?.trim() ?? "", environment);
  if (!url) throw new Error(`MCP Server「${server.name}」没有填服务器地址。`);
  const headers = expandMap(server.headers, environment);
  const bearerName = server.bearerTokenEnv?.trim();
  const bearer = bearerName ? environment[bearerName] : undefined;
  const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  if (bearer && !hasAuthorization) headers.Authorization = `Bearer ${bearer}`;
  return {
    kind: "http",
    url,
    headers,
    // `auth: false` is an explicit opt-out, and a ready-made bearer token means
    // the interactive flow would only get in the way.
    oauth: server.auth !== false && server.auth !== "bearer" && !bearer && !hasAuthorization,
  };
}
