import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "suocode-runtime-smoke-"));
const projectDir = join(temporaryRoot, "project");
const live = process.argv.includes("--live");
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# Runtime smoke project\n", "utf8");

const child = fork(join(root, "apps/desktop/out/main/runtime.js"), [], {
  env: {
    ...process.env,
    SUOCODE_AGENT_DIR: join(temporaryRoot, "agent"),
    SUOCODE_SESSION_DIR: join(temporaryRoot, "sessions"),
    SUOCODE_LEGACY_AGENT_DIR: live ? join(homedir(), ".pi", "agent") : join(temporaryRoot, "no-legacy"),
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

function waitForEvent(predicate, timeoutMs = 180_000) {
  return new Promise((resolveEvent, rejectEvent) => {
    let cursor = 0;
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

try {
  const bootstrap = await request({ type: "bootstrap" });
  if (!bootstrap?.configuration?.models) throw new Error("Bootstrap did not return model configuration.");
  const snapshot = await request({ type: "create_session", cwd: projectDir });
  if (snapshot?.project?.files?.[0]?.name !== "README.md") throw new Error("Project files were not projected.");
  const file = await request({ type: "read_file", path: "README.md" });
  if (!file.content.includes("Runtime smoke project")) throw new Error("Project file reading failed.");

  if (live) {
    const configuration = bootstrap.configuration;
    if (!configuration.provider || !configuration.modelId) throw new Error("Live smoke test has no default model.");
    if (!configuration.configuredProviders.includes(configuration.provider)) {
      throw new Error(`Live smoke test has no credential for ${configuration.provider}.`);
    }
    await request({
      type: "configure_model",
      provider: configuration.provider,
      modelId: configuration.modelId,
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
      throw new Error("The live agent did not create the expected proof file.");
    }
    if (!events.some((event) => event.type === "tool_finished" && event.tool.name === "write")) {
      throw new Error("The write tool lifecycle was not projected.");
    }
  }

  process.stdout.write(`SuoCode runtime smoke passed${live ? " (live model + tool execution)" : ""}.\n`);
} finally {
  if (child.connected) child.disconnect();
  child.kill("SIGTERM");
  rmSync(temporaryRoot, { recursive: true, force: true });
}
