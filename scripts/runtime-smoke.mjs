import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "suocode-runtime-smoke-"));
const projectDir = join(temporaryRoot, "project");
const homeDir = join(temporaryRoot, "home");
const mcpSmokeServerPath = join(root, "scripts", "fixtures", "mcp-smoke-server.mjs");
const mcpOAuthSmokeServerPath = join(root, "scripts", "fixtures", "mcp-oauth-smoke-server.mjs");
const live = process.argv.includes("--live");
mkdirSync(projectDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# Runtime smoke project\n", "utf8");
const largeDirectory = join(projectDir, "aaa-large");
mkdirSync(largeDirectory);
for (let index = 0; index < 1_205; index += 1) {
  writeFileSync(join(largeDirectory, `entry-${String(index).padStart(4, "0")}.txt`), "x", "utf8");
}
writeFileSync(join(projectDir, "zz-root.txt"), "root sibling\n", "utf8");

const oauthFixture = fork(mcpOAuthSmokeServerPath, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
let oauthFixtureError = "";
oauthFixture.stderr.on("data", (chunk) => { oauthFixtureError += chunk; });
const oauthFixtureReady = await new Promise((resolveReady, rejectReady) => {
  const timeout = setTimeout(() => rejectReady(new Error(`OAuth MCP fixture did not start. ${oauthFixtureError}`)), 15_000);
  oauthFixture.once("message", (message) => {
    clearTimeout(timeout);
    if (message?.type === "ready" && message.mcpServerUrl) resolveReady(message);
    else rejectReady(new Error(`OAuth MCP fixture returned an invalid startup message: ${JSON.stringify(message)}`));
  });
  oauthFixture.once("exit", (code) => {
    clearTimeout(timeout);
    rejectReady(new Error(`OAuth MCP fixture exited during startup (${code}). ${oauthFixtureError}`));
  });
});

const child = fork(join(root, "apps/desktop/out/main/runtime.js"), [], {
  env: {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    SUOCODE_AGENT_DIR: join(temporaryRoot, "agent"),
    SUOCODE_SESSION_DIR: join(temporaryRoot, "sessions"),
    SUOCODE_LEGACY_AGENT_DIR: live ? join(homedir(), ".pi", "agent") : join(temporaryRoot, "no-legacy"),
    PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

const pending = new Map();
const events = [];
let nextId = 0;
let runtimeError;

child.stderr.on("data", (chunk) => {
  runtimeError = `${runtimeError || ""}${chunk}`;
});
child.on("message", (message) => {
  if (message && typeof message === "object" && "event" in message) {
    events.push(message.event);
    return;
  }
  const callback = pending.get(message?.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.ok) callback.resolve(message.result);
  else callback.reject(new Error(message.error || "Runtime command failed"));
});

function request(command) {
  const id = `smoke-${++nextId}`;
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    child.send({ id, command });
  });
}

function chooseLiveSmokeModel(configuration) {
  const configured = configuration.models.filter((model) => model.configured);
  const minimaxM3 = configured.find((model) => {
    const identity = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
    return identity.includes("minimax") && /(^|[^a-z0-9])m3([^a-z0-9]|$)/i.test(identity);
  });
  return minimaxM3
    ?? configured.find((model) => model.provider === configuration.provider && model.id === "gpt-5.6-sol")
    ?? configured.find((model) => model.provider === configuration.provider && model.id === configuration.modelId)
    ?? configured[0];
}

function waitForEvent(predicate, timeoutMs = 180_000) {
  return new Promise((resolveEvent, rejectEvent) => {
    let cursor = events.length;
    const timer = setInterval(() => {
      while (cursor < events.length) {
        const event = events[cursor++];
        if (predicate(event)) {
          clearInterval(timer);
          clearTimeout(timeout);
          resolveEvent(event);
          return;
        }
      }
    }, 25);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      rejectEvent(new Error(`Timed out waiting for runtime event. ${runtimeError || ""}`));
    }, timeoutMs);
  });
}

async function waitForMcpStatus(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await request({ type: "get_mcp_status" });
    if (predicate(status)) return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Timed out waiting for MCP status: ${JSON.stringify(status)}`);
}

try {
  const mcpSecret = "suocode-mcp-secret-do-not-leak";
  const bootstrap = await request({ type: "bootstrap" });
  if (!bootstrap?.configuration?.models) throw new Error("Bootstrap did not return model configuration.");
  const initialMcp = await request({ type: "get_mcp_configuration", cwd: projectDir });
  if (!initialMcp?.configPath?.startsWith(temporaryRoot) || initialMcp.servers.length !== 0) {
    throw new Error("MCP configuration was not isolated inside the SuoCode runtime.");
  }
  const customProviderSecret = "suocode-custom-provider-secret";
  const customProvider = await request({
    type: "save_model_provider_configuration",
    input: {
      provider: {
        id: "dog-provider",
        name: "DogProvider",
        baseUrl: "http://127.0.0.1:40123/v1",
        api: "openai-completions",
        headers: { "X-Provider": "dog" },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        authHeader: true,
        replaceModels: true,
        models: [{
          id: "dog-coder-v1",
          name: "Dog Coder V1",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 65536,
          maxTokens: 8192,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            tiers: [{ inputTokensAbove: 32000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
          },
          samplingParams: { temperature: 0.2 },
        }],
        modelOverrides: {},
      },
      credential: {
        method: "api-key",
        values: { key: customProviderSecret },
        preserveFields: [],
      },
      preserveApiKeyReference: false,
    },
  });
  if (customProvider.provider?.id !== "dog-provider" || !customProvider.configuration.models.some((model) => model.provider === "dog-provider" && model.id === "dog-coder-v1")) {
    throw new Error("The Pi custom provider configuration did not create its model catalog.");
  }
  const customProviderDirectory = await request({ type: "get_model_provider_configuration" });
  const dogProvider = customProviderDirectory.providers.find((provider) => provider.id === "dog-provider");
  if (!dogProvider || dogProvider.name !== "DogProvider" || !dogProvider.apiKeyConfigured || dogProvider.models[0]?.input?.includes("image") !== true || dogProvider.models[0]?.cost?.tiers?.[0]?.inputTokensAbove !== 32000) {
    throw new Error(`The custom provider configuration was not projected back to the desktop runtime: ${JSON.stringify(dogProvider)}`);
  }
  const modelsJson = readFileSync(join(temporaryRoot, "agent", "models.json"), "utf8");
  if (modelsJson.includes(customProviderSecret)) {
    throw new Error("A private API key leaked into models.json instead of Pi auth.json.");
  }
  const removedCustomProvider = await request({ type: "remove_model_provider_configuration", provider: "dog-provider" });
  if (removedCustomProvider.models.some((model) => model.provider === "dog-provider")) {
    throw new Error("Removing a custom provider did not remove its Pi model catalog.");
  }
  const builtinDirectory = await request({ type: "get_model_provider_configuration" });
  const anthropic = builtinDirectory.providers.find((provider) => provider.id === "anthropic");
  if (!anthropic || anthropic.source !== "built-in") throw new Error("The expected Pi Anthropic provider was not available as a native provider.");
  await request({
    type: "save_model_provider_configuration",
    input: {
      provider: {
        id: anthropic.id,
        name: anthropic.name,
        baseUrl: anthropic.baseUrl,
        api: anthropic.api,
        oauth: anthropic.oauth,
        headers: anthropic.headers,
        compat: anthropic.compat,
        authHeader: anthropic.authHeader,
        replaceModels: anthropic.replaceModels,
        models: anthropic.models,
        modelOverrides: anthropic.modelOverrides,
      },
      credential: {
        method: "api-key",
        values: { key: "suocode-builtin-auth-secret" },
        preserveFields: [],
      },
      preserveApiKeyReference: false,
    },
  });
  const builtinAfterCredential = await request({ type: "get_model_provider_configuration" });
  const configuredAnthropic = builtinAfterCredential.providers.find((provider) => provider.id === "anthropic");
  if (!configuredAnthropic?.apiKeyConfigured || configuredAnthropic.source !== "built-in") {
    throw new Error("Saving a built-in Pi API key unexpectedly created a models.json provider override.");
  }
  const modelsAfterBuiltinCredential = JSON.parse(readFileSync(join(temporaryRoot, "agent", "models.json"), "utf8"));
  if (modelsAfterBuiltinCredential.providers?.anthropic) {
    throw new Error("A built-in Pi API key must stay in auth.json instead of creating an anthropic models.json override.");
  }
  const azure = builtinAfterCredential.providers.find((provider) => provider.id === "azure-openai-responses");
  const azureFields = azure?.credential.methods.find((method) => method.id === "api-key")?.fields ?? [];
  if (!azure || !azureFields.some((field) => field.id === "AZURE_OPENAI_BASE_URL") || !azureFields.some((field) => field.id === "AZURE_OPENAI_RESOURCE_NAME")) {
    throw new Error("Azure OpenAI did not expose the endpoint/resource configuration required by Pi.");
  }
  const vertex = builtinAfterCredential.providers.find((provider) => provider.id === "google-vertex");
  if (!vertex?.credential.methods.some((method) => method.id === "adc") || !vertex.credential.methods.some((method) => method.id === "service-account")) {
    throw new Error("Google Vertex did not expose Pi's ADC and service-account authentication paths.");
  }
  const bedrock = builtinAfterCredential.providers.find((provider) => provider.id === "amazon-bedrock");
  if (!bedrock?.credential.methods.some((method) => method.id === "aws-profile") || !bedrock.credential.methods.some((method) => method.id === "iam-keys") || !bedrock.credential.methods.some((method) => method.id === "credential-chain")) {
    throw new Error("Amazon Bedrock did not expose Pi's supported AWS credential paths.");
  }
  const azureSecret = "suocode-azure-secret";
  const configuredAzureResult = await request({
    type: "save_model_provider_configuration",
    input: {
      provider: {
        id: azure.id,
        name: azure.name,
        baseUrl: azure.baseUrl,
        api: azure.api,
        oauth: azure.oauth,
        headers: azure.headers,
        compat: azure.compat,
        authHeader: azure.authHeader,
        replaceModels: azure.replaceModels,
        models: azure.models,
        modelOverrides: azure.modelOverrides,
      },
      credential: {
        method: "api-key",
        values: {
          key: azureSecret,
          AZURE_OPENAI_BASE_URL: "https://smoke-resource.openai.azure.com",
          AZURE_OPENAI_API_VERSION: "2024-02-01",
          AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4o=smoke-gpt4o",
        },
        preserveFields: [],
      },
      preserveApiKeyReference: false,
    },
  });
  const configuredAzure = configuredAzureResult.provider;
  const configuredAzureFields = configuredAzure.credential.methods.find((method) => method.id === "api-key")?.fields ?? [];
  const azureKeyField = configuredAzureFields.find((field) => field.id === "key");
  const azureEndpointField = configuredAzureFields.find((field) => field.id === "AZURE_OPENAI_BASE_URL");
  if (!configuredAzure.apiKeyConfigured || !azureKeyField?.configured || azureKeyField.value !== undefined || azureEndpointField?.value !== "https://smoke-resource.openai.azure.com") {
    throw new Error("Azure OpenAI credentials were not projected safely after saving.");
  }
  const authJson = JSON.parse(readFileSync(join(temporaryRoot, "agent", "auth.json"), "utf8"));
  if (authJson["azure-openai-responses"]?.key !== azureSecret || authJson["azure-openai-responses"]?.env?.AZURE_OPENAI_BASE_URL !== "https://smoke-resource.openai.azure.com") {
    throw new Error("Azure OpenAI key and endpoint were not stored together in Pi auth.json.");
  }
  const modelsAfterAzureCredential = JSON.parse(readFileSync(join(temporaryRoot, "agent", "models.json"), "utf8"));
  if (modelsAfterAzureCredential.providers?.["azure-openai-responses"]) {
    throw new Error("Azure OpenAI connection settings must not create a custom models.json provider override.");
  }
  const savedMcp = await request({
    type: "save_mcp_server",
    cwd: projectDir,
    server: {
      name: "smoke-server",
      scope: "global",
      transport: "stdio",
      command: process.execPath,
      args: [mcpSmokeServerPath],
      env: { SUOCODE_MCP_SMOKE: "1", PRIVATE_TOKEN: mcpSecret },
      headers: {},
      lifecycle: "lazy",
      idleTimeout: 3,
      requestTimeoutMs: 4_500,
      exposeResources: true,
      directTools: ["echo"],
      excludeTools: ["dangerous"],
      debug: true,
    },
  });
  const smokeMcp = savedMcp.servers.find((server) => server.name === "smoke-server");
  if (
    !smokeMcp
    || smokeMcp.scope !== "global"
    || smokeMcp.command !== process.execPath
    || smokeMcp.env.SUOCODE_MCP_SMOKE !== "1"
    || smokeMcp.env.PRIVATE_TOKEN !== mcpSecret
    || smokeMcp.idleTimeout !== 3
    || smokeMcp.requestTimeoutMs !== 4_500
    || smokeMcp.exposeResources !== true
    || smokeMcp.directTools?.[0] !== "echo"
    || smokeMcp.excludeTools?.[0] !== "dangerous"
    || smokeMcp.debug !== true
  ) {
    throw new Error("The Pi MCP adapter configuration bridge did not preserve the extension server schema.");
  }
  const savedProjectMcp = await request({
    type: "save_mcp_server",
    cwd: projectDir,
    server: {
      ...smokeMcp,
      name: "project-smoke-server",
      scope: "project",
      debug: false,
    },
  });
  const projectMcp = savedProjectMcp.servers.find((server) => server.name === "project-smoke-server");
  if (projectMcp?.scope !== "project" || projectMcp.source !== savedProjectMcp.projectConfigPath || !existsSync(savedProjectMcp.projectConfigPath)) {
    throw new Error("The Pi MCP adapter bridge did not isolate project-level configuration in the current workspace.");
  }
  await request({ type: "remove_mcp_server", cwd: projectDir, name: "project-smoke-server", scope: "project" });
  const snapshot = await request({ type: "create_session", cwd: projectDir });
  if (!snapshot?.project?.files?.some((entry) => entry.name === "README.md")) throw new Error("Project files were not projected.");
  if (!Array.isArray(snapshot.subagents)) throw new Error("Subagent activity was not included in the session snapshot.");
  const mcpStatus = await request({ type: "get_mcp_status" });
  if (!mcpStatus.servers.some((server) => server.name === "smoke-server") || typeof mcpStatus.totalTools !== "number" || typeof mcpStatus.totalResources !== "number") {
    throw new Error(`The extension-native MCP status bridge did not expose pi-mcp-adapter state: ${JSON.stringify(mcpStatus)}`);
  }
  const disabledMcp = await request({ type: "set_mcp_server_enabled", name: "smoke-server", enabled: false, cwd: projectDir });
  if (disabledMcp.servers.find((server) => server.name === "smoke-server")?.disabled !== true) {
    throw new Error("The pi-mcp-adapter project override did not disable the MCP server.");
  }
  const disabledStatus = await waitForMcpStatus((status) => status.servers.some((server) => server.name === "smoke-server" && server.status === "disabled"));
  const disabledServerStatus = disabledStatus.servers.find((server) => server.name === "smoke-server");
  if (disabledServerStatus?.status !== "disabled" || disabledServerStatus.disabled !== true || disabledStatus.disabledCount < 1) {
    throw new Error(`The extension-native MCP status did not project the disabled server: ${JSON.stringify(disabledStatus)}`);
  }
  const enabledMcp = await request({ type: "set_mcp_server_enabled", name: "smoke-server", enabled: true, cwd: projectDir });
  if (enabledMcp.servers.find((server) => server.name === "smoke-server")?.disabled === true) {
    throw new Error("The pi-mcp-adapter project override did not re-enable the MCP server.");
  }
  await waitForMcpStatus((status) => status.state === "ready" && status.servers.some((server) => server.name === "smoke-server" && server.status !== "disabled"));
  const connectedMcp = await request({ type: "connect_mcp_server", name: "smoke-server" });
  if (!connectedMcp.text || connectedMcp.details?.error || connectedMcp.status?.servers?.find((server) => server.name === "smoke-server")?.status !== "connected") {
    throw new Error(`The bundled pi-mcp-adapter did not connect to the real stdio MCP fixture: ${JSON.stringify(connectedMcp)}`);
  }
  const connectedMcpStatus = await waitForMcpStatus((status) => status.servers.some((server) => server.name === "smoke-server" && server.status === "connected" && server.toolCount >= 1 && server.resourceCount >= 1));
  if (connectedMcpStatus.totalTools < 1 || connectedMcpStatus.totalResources < 1) {
    throw new Error(`The real MCP tool/resource discovery was not projected: ${JSON.stringify(connectedMcpStatus)}`);
  }
  await request({
    type: "save_mcp_server",
    cwd: projectDir,
    server: {
      ...smokeMcp,
      name: "failing-smoke-server",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      exposeResources: false,
      directTools: false,
    },
  });
  const failedMcpConnect = await request({ type: "connect_mcp_server", name: "failing-smoke-server" });
  if (!failedMcpConnect.text || failedMcpConnect.details?.mode !== "connect" || !failedMcpConnect.details?.error) {
    throw new Error(`The extension-native MCP connect bridge did not return pi-mcp-adapter diagnostics: ${JSON.stringify(failedMcpConnect)}`);
  }
  if (JSON.stringify(failedMcpConnect).includes(mcpSecret)) {
    throw new Error("The MCP action bridge leaked a configured credential in diagnostics.");
  }
  const loggedOutMcp = await request({ type: "logout_mcp_server", name: "failing-smoke-server" });
  if (!loggedOutMcp.text || loggedOutMcp.details?.mode !== "logout" || loggedOutMcp.details?.loggedOut !== true) {
    throw new Error(`The extension-native MCP logout bridge did not invoke pi-mcp-adapter: ${JSON.stringify(loggedOutMcp)}`);
  }
  const removedFailingMcp = await request({ type: "remove_mcp_server", cwd: projectDir, name: "failing-smoke-server", scope: "global" });
  if (removedFailingMcp.servers.some((server) => server.name === "failing-smoke-server")) {
    throw new Error("The Pi MCP adapter configuration bridge did not remove the failing test server.");
  }

  const oauthServerName = `oauth-smoke-${oauthFixtureReady.instanceId}`;
  await request({
    type: "save_mcp_server",
    cwd: projectDir,
    server: {
      name: oauthServerName,
      scope: "global",
      transport: "http",
      args: [],
      env: {},
      url: oauthFixtureReady.mcpServerUrl,
      headers: {},
      auth: "oauth",
      lifecycle: "lazy",
      exposeResources: false,
      directTools: true,
      excludeTools: [],
      debug: true,
      disabled: false,
    },
  });
  await waitForMcpStatus((status) => status.servers.some((server) => server.name === oauthServerName));
  const unauthenticatedConnect = await request({ type: "connect_mcp_server", name: oauthServerName });
  if (unauthenticatedConnect.details?.error !== "auth_required" || !unauthenticatedConnect.status?.servers?.some((server) => server.name === oauthServerName && server.status === "needs-auth")) {
    throw new Error(`The OAuth-protected MCP fixture did not require authentication: ${JSON.stringify(unauthenticatedConnect)}`);
  }
  const authStarted = await request({ type: "start_mcp_auth", name: oauthServerName });
  const authorizationUrl = authStarted.details?.authorizationUrl;
  if (!authorizationUrl || authStarted.details?.mode !== "auth-start") {
    throw new Error(`The pi-mcp-adapter did not start the real OAuth authorization-code flow: ${JSON.stringify(authStarted)}`);
  }
  const authorizationResponse = await fetch(authorizationUrl, { redirect: "manual" });
  const callbackUrl = authorizationResponse.headers.get("location");
  if (authorizationResponse.status < 300 || authorizationResponse.status >= 400 || !callbackUrl?.includes("code=") || !callbackUrl.includes("state=")) {
    throw new Error(`The OAuth fixture did not issue a PKCE callback redirect: ${authorizationResponse.status} ${callbackUrl}`);
  }
  const authCompleted = await request({ type: "complete_mcp_auth", name: oauthServerName, input: callbackUrl });
  if (authCompleted.details?.authenticated !== true || authCompleted.details?.error) {
    throw new Error(`The OAuth callback/token exchange did not complete: ${JSON.stringify(authCompleted)}`);
  }
  const authenticatedConnect = await request({ type: "connect_mcp_server", name: oauthServerName });
  if (authenticatedConnect.details?.error || !authenticatedConnect.status?.servers?.some((server) => server.name === oauthServerName && server.status === "connected" && server.toolCount >= 1)) {
    throw new Error(`The OAuth token did not authorize the MCP connection: ${JSON.stringify(authenticatedConnect)}`);
  }
  const oauthServerState = await (await fetch(new URL("/status", oauthFixtureReady.mcpServerUrl))).json();
  if (oauthServerState.clients < 1 || oauthServerState.tokens < 1 || oauthServerState.authorizedMcpRequests < 1) {
    throw new Error(`The real OAuth server did not observe registration, token issuance, and an authorized MCP request: ${JSON.stringify(oauthServerState)}`);
  }
  const oauthLogout = await request({ type: "logout_mcp_server", name: oauthServerName });
  if (oauthLogout.details?.loggedOut !== true || oauthLogout.details?.error) {
    throw new Error(`The extension-native OAuth logout did not clear credentials: ${JSON.stringify(oauthLogout)}`);
  }
  const connectAfterLogout = await request({ type: "connect_mcp_server", name: oauthServerName });
  if (connectAfterLogout.details?.error !== "auth_required" || connectAfterLogout.status?.servers?.some((server) => server.name === oauthServerName && server.status === "connected")) {
    throw new Error(`The OAuth credential remained usable after logout: ${JSON.stringify(connectAfterLogout)}`);
  }
  await request({ type: "remove_mcp_server", cwd: projectDir, name: oauthServerName, scope: "global" });

  let invalidSubagentStopRejected = false;
  try {
    await request({ type: "stop_subagent", id: "missing-smoke-subagent", background: true });
  } catch (error) {
    invalidSubagentStopRejected = !String(error).includes("超时");
  }
  if (!invalidSubagentStopRejected) {
    throw new Error("The bundled pi-subagents RPC bridge did not reject an unknown background run.");
  }
  if (!snapshot.project.files.some((entry) => entry.name === "zz-root.txt")) {
    throw new Error("A large nested directory starved later root files from the project tree.");
  }
  const largeNode = snapshot.project.files.find((entry) => entry.name === "aaa-large");
  if (!largeNode || largeNode.children !== undefined) {
    throw new Error("Project folders were traversed before the user expanded them.");
  }
  const lazyChildren = await request({ type: "list_directory", path: largeNode.path });
  if (lazyChildren.length !== 1_205 || lazyChildren.some((entry) => entry.children !== undefined)) {
    throw new Error("Lazy directory loading did not return exactly one directory level.");
  }
  const file = await request({ type: "read_file", path: "README.md" });
  if (!file.content.includes("Runtime smoke project")) throw new Error("Project file reading failed.");

  if (!live) {
    const timestamp = new Date().toISOString();
    mkdirSync(dirname(snapshot.session.path), { recursive: true });
    const subagentToolId = "subagent-smoke-tool";
    const sessionEntries = [
      { type: "session", version: 3, id: snapshot.session.id, timestamp, cwd: snapshot.session.cwd },
      {
        type: "message",
        id: "subagent-call-entry",
        parentId: null,
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: subagentToolId, name: "subagent", arguments: { agent: "scout", task: "验证扩展投影" } }],
          api: "openai-responses",
          provider: "smoke",
          model: "smoke",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: "subagent-result-entry",
        parentId: "subagent-call-entry",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: subagentToolId,
          toolName: "subagent",
          content: [{ type: "text", text: "子 Agent 已完成" }],
          details: {
            mode: "single",
            runId: "subagent-smoke-run",
            results: [{
              agent: "scout",
              task: "验证扩展投影",
              exitCode: 0,
              model: "smoke-child-model",
              usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: 0, turns: 2 },
              messages: [{ role: "assistant", content: [{ type: "thinking", text: "检查结构化事件" }, { type: "text", text: "扩展投影完成" }] }],
              toolCalls: [{ text: "读取测试文件", expandedText: "read /tmp/subagent-smoke" }],
              finalOutput: "扩展投影完成",
              transcriptPath: "/tmp/subagent-smoke.jsonl",
              sessionFile: "/tmp/subagent-smoke-session.jsonl",
            }],
          },
          isError: false,
          timestamp: Date.now(),
        },
      },
    ];
    writeFileSync(snapshot.session.path, `${sessionEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    const persistedSessions = await request({ type: "list_sessions", cwd: projectDir });
    if (!persistedSessions.some((session) => session.path === snapshot.session.path)) throw new Error("The session archive fixture was not discoverable.");
    const afterArchive = await request({ type: "archive_session", cwd: projectDir, sessionPath: snapshot.session.path });
    if (afterArchive.some((session) => session.path === snapshot.session.path)) throw new Error("Archived sessions were not hidden from the default list.");
    const archivedSessions = await request({ type: "list_archived_sessions", cwd: projectDir });
    if (!archivedSessions.some((session) => session.path === snapshot.session.path && session.archivedAt)) throw new Error("Archived sessions were not listed with archive metadata.");
    const afterRestore = await request({ type: "restore_session", cwd: projectDir, sessionPath: snapshot.session.path });
    if (!afterRestore.some((session) => session.path === snapshot.session.path)) throw new Error("Restored sessions did not return to the default list.");
    const restoredFixture = await request({ type: "open_session", cwd: projectDir, sessionPath: snapshot.session.path });
    const restoredSubagent = restoredFixture.subagents.find((activity) => activity.runId === "subagent-smoke-run");
    if (
      !restoredSubagent
      || restoredSubagent.parentToolId !== subagentToolId
      || restoredSubagent.model !== "smoke-child-model"
      || restoredSubagent.messages?.[0]?.thinking !== "检查结构化事件"
      || restoredSubagent.toolCalls?.[0]?.expandedText !== "read /tmp/subagent-smoke"
      || restoredSubagent.finalOutput !== "扩展投影完成"
    ) {
      throw new Error("The pi-subagents structured result was not restored through the SuoCode projection bridge.");
    }
  }

  if (live) {
    const configuration = bootstrap.configuration;
    if (!configuration.provider || !configuration.modelId) throw new Error("Live smoke test has no default model.");
    if (!configuration.configuredProviders.includes(configuration.provider)) {
      throw new Error(`Live smoke test has no credential for ${configuration.provider}.`);
    }
    const liveModel = chooseLiveSmokeModel(configuration);
    if (!liveModel) throw new Error("Live smoke test has no configured model.");
    await request({
      type: "configure_model",
      provider: liveModel.provider,
      modelId: liveModel.id,
      thinkingLevel: "low",
    });
    const settled = waitForEvent((event) => event.type === "run_state" && event.running === false);
    await request({
      type: "prompt",
      text: "Use the write tool to create runtime-proof.txt containing exactly SUOCODE_RUNTIME_OK followed by a newline. Then reply with a brief confirmation.",
    });
    await settled;
    const proofPath = join(projectDir, "runtime-proof.txt");
    if (!existsSync(proofPath) || readFileSync(proofPath, "utf8").trim() !== "SUOCODE_RUNTIME_OK") {
      console.error(JSON.stringify({
        runtimeError,
        events: events.filter((event) => !["runtime_ready", "configuration_updated", "session_snapshot", "project_updated"].includes(event.type)).slice(-30).map((event) => ({
          type: event.type,
          running: event.running,
          message: event.message?.text || event.message,
          tool: event.tool ? { name: event.tool.name, status: event.tool.status, label: event.tool.label, output: event.tool.output } : undefined,
        })),
      }, null, 2));
      throw new Error("The live agent did not create the expected proof file.");
    }
    const writeToolEvent = events.find((event) => event.type === "tool_finished" && event.tool.name === "write");
    if (!writeToolEvent) {
      throw new Error("The write tool lifecycle was not projected.");
    }
    if (!writeToolEvent.tool.label || writeToolEvent.tool.label === "写入 runtime-proof.txt") {
      throw new Error(`The workflow purpose was not projected into the tool label: ${writeToolEvent.tool.label || "<empty>"}`);
    }
    const metricsEvent = events.findLast((event) => event.type === "metrics_updated");
    if (!metricsEvent?.responseMetrics || metricsEvent.responseMetrics.outputTokens <= 0) {
      throw new Error("The workflow response metrics were not projected.");
    }
    if (
      typeof metricsEvent.responseMetrics.inputTokens !== "number"
      || typeof metricsEvent.responseMetrics.cacheReadTokens !== "number"
      || typeof metricsEvent.responseMetrics.cacheWriteTokens !== "number"
    ) {
      throw new Error("Per-request input and cache token fields were not projected.");
    }
    const restored = await request({ type: "open_session", cwd: projectDir, sessionPath: snapshot.session.path });
    const restoredWriteTool = restored.tools.find((tool) => tool.name === "write");
    if (!restoredWriteTool || restoredWriteTool.label !== writeToolEvent.tool.label) {
      throw new Error(
        `The workflow purpose was not restored from session audit entries: ${restoredWriteTool?.label || "<missing>"}`,
      );
    }
    if (!restored.responseMetrics || restored.responseMetrics.timestamp !== metricsEvent.responseMetrics.timestamp) {
      throw new Error("The workflow response metrics were not restored from the session.");
    }
    if (!Array.isArray(restored.responseMetricsHistory) || restored.responseMetricsHistory.length < 1) {
      throw new Error("The response performance history was not restored from the session.");
    }
    if (!restored.contextUsage?.contextWindow || restored.tokenUsage.output <= 0) {
      throw new Error("Context and token usage were not included in the restored session snapshot.");
    }
    const mcpEchoToken = `SUOCODE_MCP_ECHO_${Date.now()}`;
    const mcpEventStart = events.length;
    const mcpSettled = waitForEvent((event) => event.type === "run_state" && event.running === false);
    await request({
      type: "prompt",
      text: `Call the smoke_server_echo tool exactly once with text ${mcpEchoToken}. Do not call any other tool. Then reply exactly ${mcpEchoToken}.`,
    });
    await mcpSettled;
    const mcpToolEvent = events.slice(mcpEventStart).find((event) => event.type === "tool_finished" && event.tool.name === "smoke_server_echo");
    if (!mcpToolEvent || !mcpToolEvent.tool.output.includes(`MCP_ECHO:${mcpEchoToken}`)) {
      throw new Error(`The live Agent did not execute the direct tool supplied by pi-mcp-adapter: ${JSON.stringify(events.slice(mcpEventStart))}`);
    }
    const rewindTarget = restored.messages.find((message) => message.role === "user");
    if (!rewindTarget?.entryId) throw new Error("Historical user messages did not expose a Pi session entry ID.");
    const rewindToken = `SUOCODE_REWIND_OK_${Date.now()}`;
    const rewindEventStart = events.length;
    const rewindSettled = waitForEvent((event) => event.type === "run_state" && event.running === false);
    await request({ type: "rewind_prompt", entryId: rewindTarget.entryId, text: `Reply exactly ${rewindToken}.` });
    const immediateRewindSnapshot = events.slice(rewindEventStart).find((event) => event.type === "session_snapshot");
    if (!immediateRewindSnapshot) {
      throw new Error("Rewinding did not publish the cleaned Pi branch before starting the replacement request.");
    }
    if (immediateRewindSnapshot.snapshot.messages.some((message) => message.role === "assistant")) {
      throw new Error("The immediate rewind snapshot still contained assistant messages from the abandoned branch.");
    }
    await rewindSettled;
    const rewound = await request({ type: "open_session", cwd: projectDir, sessionPath: snapshot.session.path });
    if (!rewound.messages.some((message) => message.role === "user" && message.text.includes(rewindToken))) {
      throw new Error("Rewinding and resubmitting did not move the active Pi branch to the edited message.");
    }
    if ((rewound.responseMetricsHistory?.length ?? 0) < 2) {
      throw new Error("Performance history did not retain both model requests.");
    }
  }

  const removedMcp = await request({ type: "remove_mcp_server", cwd: projectDir, name: "smoke-server", scope: "global" });
  if (removedMcp.servers.some((server) => server.name === "smoke-server")) {
    throw new Error("The Pi MCP adapter configuration bridge did not remove the real test server.");
  }

  process.stdout.write(`SuoCode runtime smoke passed${live ? " (live model + tool execution)" : ""}.\n`);
} finally {
  if (child.connected) child.disconnect();
  child.kill("SIGTERM");
  if (oauthFixture.connected) oauthFixture.send({ type: "shutdown" });
  oauthFixture.kill("SIGTERM");
  rmSync(temporaryRoot, { recursive: true, force: true });
}
