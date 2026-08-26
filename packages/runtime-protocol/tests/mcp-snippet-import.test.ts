import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpServerSnippets } from "../src/index.ts";

test("a bare server object is accepted, which is the shape READMEs show", () => {
  const result = parseMcpServerSnippets(`{
    "args": ["-y", "chrome-devtools-mcp@latest"],
    "command": "npx",
    "env": {},
    "type": "stdio"
  }`);

  assert.ok(result.ok);
  assert.deepEqual(result.servers, [{
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
    env: {},
    headers: {},
  }]);
  // Nothing in the snippet names it, so the editor has to ask.
  assert.equal(result.servers[0]?.name, undefined);
});

test("a whole mcpServers document keeps every server and its name", () => {
  const result = parseMcpServerSnippets(`{
    "mcpServers": {
      "chrome": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] },
      "keenable": { "url": "https://api.keenable.ai/mcp", "headers": { "X-API-Key": "abc" } }
    }
  }`);

  assert.ok(result.ok);
  assert.deepEqual(result.servers.map((server) => [server.name, server.transport]), [["chrome", "stdio"], ["keenable", "http"]]);
  assert.deepEqual(result.servers[1]?.headers, { "X-API-Key": "abc" });
});

test("the VS Code servers key and a single name/value pair both work", () => {
  const vscode = parseMcpServerSnippets(`{ "servers": { "fs": { "command": "npx", "args": ["-y", "server-filesystem"] } } }`);
  assert.ok(vscode.ok);
  assert.deepEqual(vscode.servers.map((server) => server.name), ["fs"]);

  const pair = parseMcpServerSnippets(`{ "keenable": { "url": "https://api.keenable.ai/mcp" } }`);
  assert.ok(pair.ok);
  assert.deepEqual(pair.servers.map((server) => [server.name, server.url]), [["keenable", "https://api.keenable.ai/mcp"]]);
});

test("stdio fields are dropped from an HTTP server and the reverse", () => {
  // Carrying an empty env onto an HTTP server would write a field the file has
  // no use for, and headers onto a stdio one is the same mistake mirrored.
  const http = parseMcpServerSnippets(`{ "url": "https://example.com/mcp", "headers": { "A": "b" }, "args": ["x"], "env": { "K": "v" } }`);
  assert.ok(http.ok);
  assert.deepEqual(http.servers[0], { transport: "http", url: "https://example.com/mcp", args: [], env: {}, headers: { A: "b" } });

  const stdio = parseMcpServerSnippets(`{ "command": "npx", "headers": { "A": "b" } }`);
  assert.ok(stdio.ok);
  assert.deepEqual(stdio.servers[0]?.headers, {});
});

test("nothing usable is reported rather than half-imported", () => {
  assert.equal(parseMcpServerSnippets("").ok, false);
  assert.equal(parseMcpServerSnippets("{").ok, false);
  assert.equal(parseMcpServerSnippets(`{ "mcpServers": { "broken": { "disabled": true } } }`).ok, false);
  assert.equal(parseMcpServerSnippets(`{ "hello": "world" }`).ok, false);
});
