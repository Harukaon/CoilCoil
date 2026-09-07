import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpCredentialStore, credentialKey, defaultCredentialFile } from "../src/credential-store.ts";

function store(): { store: McpCredentialStore; file: string } {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-store-"));
  const file = defaultCredentialFile(join(directory, "agent"));
  return { store: new McpCredentialStore(file), file };
}

test("一个授权跟着地址走，不跟着名字走", () => {
  // 同一个服务器在设置里改个名，登录不该没；两个条目指着同一个地址，本来就该
  // 共用那一份授权。
  assert.equal(credentialKey("https://mcp.example.com/v1"), credentialKey("https://MCP.Example.com/v1/"));
  assert.notEqual(credentialKey("https://mcp.example.com/v1"), credentialKey("https://mcp.example.com/v2"));
  // 查询串里常常带着一次性的 token 或者防缓存参数，进了键就等于每次都要重新授权。
  assert.equal(credentialKey("https://mcp.example.com/v1?t=1"), credentialKey("https://mcp.example.com/v1?t=2"));
});

test("不是 URL 的服务器也有稳定的键", () => {
  const key = credentialKey("npx -y some-server");
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(key, credentialKey("npx -y some-server"));
});

test("凭据文件只有本人读得了", () => {
  const { store: credentials, file } = store();
  credentials.update("k", { tokens: { access_token: "secret" } });
  // 这里面是 bearer token，跟私钥一个级别，同机器上的别人不该看得见。
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("写坏一半也不会把人全部登出", () => {
  const { store: credentials, file } = store();
  credentials.update("a", { tokens: { access_token: "one" } });
  const before = readFileSync(file, "utf8");
  credentials.update("b", { tokens: { access_token: "two" } });
  assert.notEqual(readFileSync(file, "utf8"), before);
  // 先写临时文件再改名，所以目录里不该留下半截文件。
  const directory = file.slice(0, file.lastIndexOf("/"));
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
});

test("文件坏掉就当没登录过，而不是让进程崩掉", () => {
  const { store: credentials, file } = store();
  credentials.update("a", { tokens: { access_token: "one" } });
  writeFileSync(file, "{ 这不是 JSON", "utf8");
  assert.equal(credentials.get("a"), undefined);
  // 坏文件之后仍然写得进去：最坏的代价是重新授权一次。
  credentials.update("a", { tokens: { access_token: "two" } });
  assert.deepEqual(credentials.get("a")?.tokens, { access_token: "two" });
});

test("update 是合并，传 undefined 才是删掉那一项", () => {
  const { store: credentials } = store();
  credentials.update("a", { clientInformation: { client_id: "abc" }, codeVerifier: "v" });
  credentials.update("a", { tokens: { access_token: "one" } });
  assert.deepEqual(credentials.get("a")?.clientInformation, { client_id: "abc" });
  // PKCE 的 verifier 只在换令牌那一下有用，换完就该消失。
  credentials.update("a", { codeVerifier: undefined });
  assert.equal(credentials.get("a")?.codeVerifier, undefined);
  assert.deepEqual(credentials.get("a")?.tokens, { access_token: "one" });
});

test("登出连动态注册的客户端一起删", () => {
  const { store: credentials } = store();
  credentials.update("a", { tokens: { access_token: "one" }, clientInformation: { client_id: "abc" } });
  credentials.update("b", { tokens: { access_token: "two" } });
  credentials.clear("a");
  // 只删令牌、留着注册信息，下次授权会悄悄复用一个用户以为已经扔掉的身份。
  assert.equal(credentials.get("a"), undefined);
  assert.deepEqual(credentials.get("b")?.tokens, { access_token: "two" });
});

test("认得出谁手上有能用的令牌", () => {
  const { store: credentials } = store();
  credentials.update("a", { tokens: { access_token: "one" } });
  credentials.update("b", { clientInformation: { client_id: "abc" } });
  credentials.update("c", { tokens: {} });
  assert.deepEqual(credentials.authenticatedKeys(), ["a"]);
});
