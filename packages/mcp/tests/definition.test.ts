import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";
import { expandPlaceholders, launchFor, missingPlaceholders } from "../src/definition.ts";

function server(overrides: Partial<McpServerConfiguration> = {}): McpServerConfiguration {
  return {
    name: "github",
    scope: "global",
    transport: "http",
    args: [],
    env: {},
    headers: {},
    lifecycle: "lazy",
    exposeResources: false,
    directTools: false,
    excludeTools: [],
    debug: false,
    disabled: false,
    ...overrides,
  } as McpServerConfiguration;
}

test("两种占位符写法都认", () => {
  const environment = { TOKEN: "t-1" };
  assert.equal(expandPlaceholders("Bearer ${TOKEN}", environment), "Bearer t-1");
  assert.equal(expandPlaceholders("Bearer $env:TOKEN", environment), "Bearer t-1");
});

test("变量没设就展开成空，而不是把占位符原样发出去", () => {
  // 原样发出去，服务器只会回一个看不出原因的 401；发空的至少是「没凭据」这个
  // 老实答案。
  assert.equal(expandPlaceholders("Bearer ${MISSING}", {}), "Bearer ");
});

test("数得出哪些变量还没设", () => {
  const entry = server({
    transport: "stdio",
    command: "npx",
    args: ["-y", "${PKG}"],
    env: { TOKEN: "${GITHUB_TOKEN}" },
    bearerTokenEnv: "OTHER_TOKEN",
  });
  assert.deepEqual(missingPlaceholders(entry, { PKG: "x" }), ["GITHUB_TOKEN", "OTHER_TOKEN"]);
  assert.deepEqual(
    missingPlaceholders(entry, { PKG: "x", GITHUB_TOKEN: "g", OTHER_TOKEN: "o" }),
    [],
  );
});

test("stdio 子进程继承当前环境，条目自己的变量盖在上面", () => {
  // 这些服务器多半是 npx 包装，拿不到 PATH 就直接「command not found」。
  const launch = launchFor(
    server({ transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "own" } }),
    { PATH: "/usr/bin", TOKEN: "inherited" },
  );
  assert.equal(launch.kind, "stdio");
  assert.equal(launch.kind === "stdio" && launch.env.PATH, "/usr/bin");
  assert.equal(launch.kind === "stdio" && launch.env.TOKEN, "own");
});

test("没填命令或者地址就直接说清楚是哪一个服务器", () => {
  assert.throws(() => launchFor(server({ transport: "stdio" }), {}), /github.*启动命令/s);
  assert.throws(() => launchFor(server({ transport: "http" }), {}), /github.*服务器地址/s);
});

test("bearerTokenEnv 变成一个普通的 Authorization 头", () => {
  const launch = launchFor(
    server({ url: "https://example.com/mcp", bearerTokenEnv: "GH" }),
    { GH: "t-1" },
  );
  assert.equal(launch.kind === "http" && launch.headers.Authorization, "Bearer t-1");
  // 已经有现成令牌了，再去走一遍浏览器授权只是碍事。
  assert.equal(launch.kind === "http" && launch.oauth, false);
});

test("用户自己写的 Authorization 头压过 bearerTokenEnv", () => {
  const launch = launchFor(
    server({ url: "https://example.com/mcp", bearerTokenEnv: "GH", headers: { authorization: "Basic abc" } }),
    { GH: "t-1" },
  );
  assert.equal(launch.kind === "http" && launch.headers.authorization, "Basic abc");
  assert.equal(launch.kind === "http" && launch.headers.Authorization, undefined);
  assert.equal(launch.kind === "http" && launch.oauth, false);
});

test("只有真的需要浏览器授权的服务器才走 OAuth", () => {
  const withOAuth = launchFor(server({ url: "https://example.com/mcp" }), {});
  assert.equal(withOAuth.kind === "http" && withOAuth.oauth, true);
  // `auth: false` 是明确的不要认证。
  const optedOut = launchFor(server({ url: "https://example.com/mcp", auth: false }), {});
  assert.equal(optedOut.kind === "http" && optedOut.oauth, false);
});
