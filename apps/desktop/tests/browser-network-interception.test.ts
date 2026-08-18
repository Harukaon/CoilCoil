import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { interceptNetworkRequest } from "../../../node_modules/chrome-devtools-mcp/build/src/tools/intercept-network-request.js";

class FakePage extends EventEmitter {
  readonly interceptionChanges: boolean[] = [];

  async setRequestInterception(enabled: boolean): Promise<void> {
    this.interceptionChanges.push(enabled);
  }
}

class FakeRequest {
  handled = false;
  readonly continued: Array<Record<string, unknown>> = [];
  readonly mocked: Array<Record<string, unknown>> = [];
  readonly blocked: string[] = [];
  private readonly requestUrl: string;
  private readonly requestMethod: string;
  private readonly requestResourceType: string;
  private readonly requestHeaders: Record<string, string>;

  constructor(
    requestUrl: string,
    requestMethod = "GET",
    requestResourceType = "fetch",
    requestHeaders: Record<string, string> = { accept: "application/json" },
  ) {
    this.requestUrl = requestUrl;
    this.requestMethod = requestMethod;
    this.requestResourceType = requestResourceType;
    this.requestHeaders = requestHeaders;
  }

  url(): string { return this.requestUrl; }
  method(): string { return this.requestMethod; }
  resourceType(): string { return this.requestResourceType; }
  headers(): Record<string, string> { return { ...this.requestHeaders }; }
  isInterceptResolutionHandled(): boolean { return this.handled; }

  async continue(overrides: Record<string, unknown> = {}): Promise<void> {
    this.handled = true;
    this.continued.push(overrides);
  }

  async respond(response: Record<string, unknown>): Promise<void> {
    this.handled = true;
    this.mocked.push(response);
  }

  async abort(reason: string): Promise<void> {
    this.handled = true;
    this.blocked.push(reason);
  }
}

async function callTool(page: FakePage, params: Record<string, unknown>): Promise<string> {
  const lines: string[] = [];
  await interceptNetworkRequest.handler(
    { params, page: { pptrPage: page } },
    { appendResponseLine: (line: string) => lines.push(line) },
  );
  return lines.join("\n");
}

async function settleRequestHandler(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("request interception mocks matching requests and passes unmatched requests through", async () => {
  const page = new FakePage();
  const added = await callTool(page, {
    operation: "add",
    urlPattern: "*://*/api/users*",
    requestMethod: "GET",
    resourceTypes: ["fetch"],
    behavior: "mock",
    response: {
      status: 201,
      contentType: "application/json",
      headers: { "x-suocode-mock": "yes" },
      body: '{"source":"mock"}',
    },
  });
  const ruleId = added.match(/intercept-\d+/)?.[0];
  assert.ok(ruleId);
  assert.deepEqual(page.interceptionChanges, [true]);

  const unmatched = new FakeRequest("http://localhost/api/users", "POST");
  page.emit("request", unmatched);
  await settleRequestHandler();
  assert.deepEqual(unmatched.continued, [{}]);

  const matched = new FakeRequest("http://localhost/api/users?page=1");
  page.emit("request", matched);
  await settleRequestHandler();
  assert.equal(matched.mocked.length, 1);
  assert.deepEqual(matched.mocked[0], {
    status: 201,
    headers: { "x-suocode-mock": "yes" },
    contentType: "application/json",
    body: '{"source":"mock"}',
  });

  const listed = await callTool(page, { operation: "list" });
  assert.match(listed, new RegExp(ruleId));
  assert.match(listed, /"matchCount": 1/);
  await callTool(page, { operation: "remove", ruleId });
  assert.deepEqual(page.interceptionChanges, [true, false]);
});

test("newer continue rules override broader block rules", async () => {
  const page = new FakePage();
  await callTool(page, {
    operation: "add",
    urlPattern: "*://*/api/*",
    behavior: "block",
    errorReason: "blockedbyclient",
  });
  await callTool(page, {
    operation: "add",
    urlPattern: "*://*/api/health",
    behavior: "continue",
    requestOverrides: {
      method: "POST",
      headers: { "x-suocode-test": "1" },
      postData: "probe=true",
    },
  });

  const health = new FakeRequest("http://localhost/api/health");
  page.emit("request", health);
  await settleRequestHandler();
  assert.deepEqual(health.continued, [{
    method: "POST",
    postData: "probe=true",
    headers: { accept: "application/json", "x-suocode-test": "1" },
  }]);

  const blocked = new FakeRequest("http://localhost/api/private");
  page.emit("request", blocked);
  await settleRequestHandler();
  assert.deepEqual(blocked.blocked, ["blockedbyclient"]);

  await callTool(page, { operation: "clear" });
  assert.deepEqual(page.interceptionChanges, [true, false]);
});

test("limited rules remove themselves and disable interception", async () => {
  const page = new FakePage();
  await callTool(page, {
    operation: "add",
    urlPattern: "*://*/once",
    behavior: "mock",
    times: 1,
  });

  const request = new FakeRequest("http://localhost/once");
  page.emit("request", request);
  await settleRequestHandler();
  await settleRequestHandler();
  assert.equal(request.mocked.length, 1);
  assert.deepEqual(page.interceptionChanges, [true, false]);

  const listed = await callTool(page, { operation: "list" });
  assert.match(listed, /"interceptionEnabled": false/);
  assert.match(listed, /"rules": \[\]/);
});
