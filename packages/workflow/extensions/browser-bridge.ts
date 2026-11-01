export const BROWSER_MCP_SERVER = "coilcoil-browser";

interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

/** 桌面端 CDP 桥上 CoilCoil 自己的 HTTP 接口（标签页列表），和 CDP 连接同一套地址和令牌。 */
export function browserBridgeEndpoint(path: string, scope: string, env: NodeJS.ProcessEnv = process.env): Endpoint | undefined {
  try {
    const args = JSON.parse(env.COILCOIL_BROWSER_MCP_ARGS ?? "") as unknown;
    if (!Array.isArray(args)) return undefined;
    const valueAfter = (flag: string): string | undefined => {
      const index = args.indexOf(flag);
      return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1] as string : undefined;
    };
    const endpoint = valueAfter("--wsEndpoint");
    if (!endpoint) return undefined;
    const socket = new URL(endpoint);
    const token = /^\/devtools\/browser\/([^/]+)$/.exec(socket.pathname)?.[1];
    if (!token) return undefined;
    const headers = JSON.parse(valueAfter("--wsHeaders") ?? "{}") as Record<string, string>;
    const url = new URL(`http://${socket.host}/coilcoil/${path}/${token}`);
    url.searchParams.set("scope", scope);
    return { url: url.toString(), headers };
  } catch {
    return undefined;
  }
}
