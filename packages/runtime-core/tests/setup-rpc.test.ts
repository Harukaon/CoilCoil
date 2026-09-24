import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  installSetupRpc,
  setupRpcReplyChannel,
} from "../src/runtime-setup-rpc.js";
import {
  SETUP_RPC_REPLY_PREFIX,
  SETUP_RPC_REQUEST_CHANNEL,
} from "../src/runtime-constants.js";

function unusedHost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fail = async () => { throw new Error("unused"); };
  return {
    getMcpConfiguration: fail,
    getMcpJson: fail,
    saveMcpJson: fail,
    saveMcpServer: fail,
    removeMcpServer: fail,
    setMcpServerEnabled: fail,
    discoverMcpServers: fail,
    importMcpServers: fail,
    enableMcpImports: fail,
    connectMcpServer: fail,
    startMcpAuth: fail,
    awaitMcpAuthCallback: fail,
    finishMcpAuth: fail,
    awaitMcpAuth: fail,
    cancelMcpAuth: fail,
    completeMcpAuth: fail,
    logoutMcpServer: fail,
    setSessionMcpServerEnabled: fail,
    getSkillConfiguration: fail,
    setSkillEnabled: fail,
    removeSkill: fail,
    deleteSkill: fail,
    addSkillPath: fail,
    removeSkillPath: fail,
    setSessionSkillEnabled: fail,
    ...overrides,
  };
}

function ghServer(env: Record<string, string>): Record<string, unknown> {
  return {
    name: "gh",
    scope: "global",
    transport: "stdio",
    command: "npx",
    args: [],
    env,
    headers: {},
    lifecycle: "lazy",
    exposeResources: true,
    directTools: false,
    excludeTools: [],
    debug: false,
    disabled: false,
  };
}

function ask(bus: ReturnType<typeof createEventBus>, requestId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const reply = new Promise<unknown>((resolve) => {
    bus.on(setupRpcReplyChannel(requestId), (raw) => resolve(raw));
  });
  bus.emit(SETUP_RPC_REQUEST_CHANNEL, { version: 1, requestId, method, params });
  return reply;
}

test("通道常量与回复通道格式", () => {
  assert.equal(SETUP_RPC_REQUEST_CHANNEL, "coilcoil:setup:rpc:v1:request");
  assert.equal(SETUP_RPC_REPLY_PREFIX, "coilcoil:setup:rpc:v1:reply:");
  assert.equal(setupRpcReplyChannel("abc"), "coilcoil:setup:rpc:v1:reply:abc");
});

test("mcp_list：敏感值脱敏，原值不出总线", async () => {
  const bus = createEventBus();
  installSetupRpc(unusedHost({
    getMcpConfiguration: async () => ({
      configPath: "/tmp/mcp.json",
      imports: [],
      servers: [ghServer({ GITHUB_TOKEN: "real-secret", PLAIN: "hello" })],
    }),
  }) as never, bus, () => undefined);
  const answered = await ask(bus, "t-list", "mcp_list") as {
    success: boolean;
    data: { configuration: { servers: Array<{ env: Record<string, string> }> } };
  };
  assert.equal(answered.success, true);
  // 整个应答里不该出现原值：脱敏不彻底等于没脱。
  assert.doesNotMatch(JSON.stringify(answered), /real-secret/);
  assert.equal(answered.data.configuration.servers[0]!.env.GITHUB_TOKEN, "••••••");
  assert.equal(answered.data.configuration.servers[0]!.env.PLAIN, "hello");
});

test("mcp_save_server：掩码原样传回表示不改", async () => {
  const bus = createEventBus();
  let saved: { env: Record<string, string> } | undefined;
  installSetupRpc(unusedHost({
    getMcpConfiguration: async () => ({
      configPath: "/tmp/mcp.json",
      imports: [],
      servers: [ghServer({ GITHUB_TOKEN: "real-secret" })],
    }),
    saveMcpServer: async (server: { env: Record<string, string> }) => {
      saved = { env: server.env };
      return { configPath: "/tmp/mcp.json", imports: [], servers: [] };
    },
  }) as never, bus, () => undefined);
  const answered = await ask(bus, "t-unmask", "mcp_save_server", {
    server: { ...ghServer({ GITHUB_TOKEN: "••••••" }) },
  }) as { success: boolean };
  assert.equal(answered.success, true);
  assert.equal(saved?.env.GITHUB_TOKEN, "real-secret");
});

test("没会话就直说，不干活", async () => {
  const bus = createEventBus();
  installSetupRpc(unusedHost() as never, bus, () => { throw new Error("no session"); });
  const answered = await ask(bus, "t-nosession", "mcp_list") as {
    success: boolean;
    error: { message: string };
  };
  assert.equal(answered.success, false);
  assert.match(answered.error.message, /请先打开项目/);
});

test("model_list/model_save：服务商配置走同一条 setup RPC", async () => {
  const bus = createEventBus();
  const configuration = {
    configPath: "/tmp/models.json",
    supportedApis: [{ id: "openai-completions", label: "Chat", description: "" }],
    providers: [{
      id: "demo",
      name: "Demo",
      disabled: false,
      apiKeyConfigured: false,
      hasPrivateApiKeyReference: false,
      replaceModels: true,
      models: [{ id: "demo-model", contextWindow: 128000, maxTokens: 8192, input: ["text"] }],
      source: "custom",
      credential: { methods: [] },
    }],
  };
  let saved: Record<string, unknown> | undefined;
  installSetupRpc(unusedHost({
    getModelProviderConfiguration: async () => configuration,
    saveModelProviderPatch: async (input: Record<string, unknown>) => {
      saved = input;
      return { provider: configuration.providers[0], configuration: {} };
    },
  }) as never, bus, () => undefined);
  const listed = await ask(bus, "model-list", "model_list") as { success: boolean; data: { configuration: typeof configuration } };
  assert.equal(listed.success, true);
  assert.equal(listed.data.configuration.providers[0]?.models[0]?.maxTokens, 8192);
  const savedReply = await ask(bus, "model-save", "model_save", {
    provider: { id: "demo", models: [{ id: "demo-model", contextWindow: 256000 }] },
  }) as { success: boolean };
  assert.equal(savedReply.success, true);
  assert.equal(saved?.id, "demo");
});

test("报错文本里的敏感值同样脱敏", async () => {
  const bus = createEventBus();
  installSetupRpc(unusedHost({
    getMcpConfiguration: async () => ({
      configPath: "/tmp/mcp.json",
      imports: [],
      servers: [ghServer({ GITHUB_TOKEN: "real-secret" })],
    }),
    connectMcpServer: async () => { throw new Error("connect real-secret failed"); },
  }) as never, bus, () => undefined);
  const answered = await ask(bus, "t-redact", "mcp_connect", { name: "gh" }) as {
    success: boolean;
    error: { message: string };
  };
  assert.equal(answered.success, false);
  assert.doesNotMatch(answered.error.message, /real-secret/);
});
