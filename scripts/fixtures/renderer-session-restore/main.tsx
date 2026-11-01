import "../../../apps/desktop/src/renderer/src/ui/form/form.css";
import "../../../apps/desktop/src/renderer/src/styles.css";
import "../../../apps/desktop/src/renderer/src/mobile.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../../../apps/desktop/src/renderer/src/App";
import { ToastHost } from "../../../apps/desktop/src/renderer/src/ui/toast";
import type { RuntimeCommand, RuntimeEvent, SessionSnapshot } from "@coilcoil/runtime-protocol";

const project = { name: "Smoke Project", path: "/smoke/project", kind: "home" as const };
const model = { provider: "local-fake", providerName: "Local Fake", id: "fake", name: "Offline Fake", contextWindow: 200_000,
  supportsImages: false, supportsReasoning: false, supportedThinkingLevels: ["off"], configured: true };
const configuration = { provider: model.provider, modelId: model.id, thinkingLevel: "off", models: [model], configuredProviders: [model.provider] };
const projectState = { cwd: project.path, files: [], changes: [], terminals: [], refreshedAt: 0 };
const runtimeInspection = { sessionRevision: 1, summaryEvents: [], systemPromptOverride: false, estimates: {}, tools: [], skills: [],
  capabilities: { editSystemPrompt: false, removeOriginalSessionItems: false } };
const snapshots = new Map<string, SessionSnapshot>(["A", "B"].map((id) => [id, {
  runtimeId: `runtime-${id}`,
  session: { id, path: `/smoke/sessions/${id}.jsonl`, cwd: project.path, title: `Session ${id}`, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 2 },
  messageRevision: 2,
  messages: [
    { id: `user-${id}`, order: 1, role: "user", text: `Question ${id}`, timestamp: 1 },
    { id: `assistant-${id}`, order: 2, role: "assistant", text: `${id}-START`, timestamp: 2, status: id === "A" ? "running" : "succeeded" },
  ],
  running: id === "A", agentMode: "standard", thinkingLevel: "off", model, project: projectState,
  promptQueue: [], steering: [], tools: [], subagents: [], runtimeInspection,
} as unknown as SessionSnapshot]));
const listeners = new Set<(event: RuntimeEvent, runtimeId?: string) => void>();
const calls: Array<{ type: string; runtimeId?: string }> = [];
const trace: Array<Record<string, unknown>> = [];
let heldOpen: string | undefined;
let release: (() => void) | undefined;
const copy = <T,>(value: T): T => structuredClone(value);
function emit(id: string, event: RuntimeEvent) {
  trace.push({ type: event.type, id, at: performance.now(), ..."revision" in event ? { revision: event.revision } : {},
    ...event.type === "message_delta" ? { delta: event.delta } : {} });
  for (const listener of listeners) listener(copy(event), `runtime-${id}`);
}
const revision = (snapshot: SessionSnapshot) => snapshot.messageRevision = (snapshot.messageRevision ?? 0) + 1;

async function request(command: RuntimeCommand, runtimeId?: string): Promise<unknown> {
  calls.push({ type: command.type, runtimeId });
  const id = runtimeId?.slice("runtime-".length) ?? "A";
  const snapshot = snapshots.get(id)!;
  switch (command.type) {
    case "bootstrap": return { configuration, homeProject: project };
    case "get_configuration": return configuration;
    case "open_workspace": return { sessions: [...snapshots.values()].map((item) => copy(item.session)), snapshot: copy(snapshots.get("A")) };
    case "list_sessions": return [...snapshots.values()].map((item) => copy(item.session));
    case "get_skill_configuration": return { skills: [] };
    case "get_mcp_configuration": return { servers: [] };
    case "open_session": {
      const target = [...snapshots.values()].find((item) => item.session.path === command.sessionPath)!;
      const captured = copy(target);
      if (heldOpen === target.session.id) {
        heldOpen = undefined;
        trace.push({ type: "snapshot-held", revision: captured.messageRevision, at: performance.now() });
        await new Promise<void>((resolve) => { release = () => {
          trace.push({ type: "snapshot-released", revision: captured.messageRevision, at: performance.now() });
          release = undefined; resolve();
        }; });
      }
      return captured;
    }
    case "prompt": {
      snapshot.promptQueue.push({ id: command.clientMessageId!, text: command.text, promptDocument: command.promptDocument, queuedAt: Date.now() });
      emit(id, { type: "prompt_queue_updated", queue: snapshot.promptQueue, revision: revision(snapshot) });
      return { accepted: true };
    }
    case "promote_queued_prompt": {
      const queued = snapshot.promptQueue.find((item) => item.id === command.id)!;
      snapshot.promptQueue = snapshot.promptQueue.filter((item) => item.id !== command.id);
      emit(id, { type: "prompt_queue_updated", queue: snapshot.promptQueue, revision: revision(snapshot) });
      const steering = { id: queued.id, text: queued.text, promptDocument: queued.promptDocument, timestamp: Date.now() };
      snapshot.steering.push(steering);
      emit(id, { type: "message_steering", ...steering, revision: revision(snapshot) });
      return { promoted: true, steered: true };
    }
    case "abort": {
      for (const steering of snapshot.steering) emit(id, { type: "message_rejected", ...steering, revision: revision(snapshot) });
      snapshot.steering = [];
      snapshot.running = false;
      snapshot.backgroundWait = undefined;
      const assistant = snapshot.messages.find((item) => item.role === "assistant")!;
      assistant.status = "aborted";
      emit(id, { type: "message_finished", message: assistant, revision: revision(snapshot) });
      emit(id, { type: "run_state", running: false });
      emit(id, { type: "background_wait_updated", backgroundWait: { waiting: false, monitorIds: [] } });
      emit(id, { type: "session_snapshot", snapshot: copy(snapshot) });
      return { aborted: true };
    }
    default: throw new Error(`Unexpected fake runtime command: ${command.type}`);
  }
}

Object.assign(window, {
  coilcoil: {
    platform: "darwin", request,
    homeProject: async () => project,
    mountedProjects: async () => [], setMountedProjects: async () => {}, setBadgeCount: async () => {},
    setWindowMinimumWidth: async () => {}, growWindowWidth: async () => {}, writeDiagnostics: async () => {},
    onRuntimeEvent: (listener: (event: RuntimeEvent, runtimeId?: string) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    onBrowserAgentActivated: () => () => {}, onOpenBubbleSession: () => () => {},
    onBrowserStateUpdated: () => () => {}, setBrowserScope: async (scopeId: string) => ({ scopeId, tabs: [], zoom: 1 }),
  },
  smoke: {
    calls, trace,
    holdOpen: (id: string) => { heldOpen = id; },
    pendingOpen: () => Boolean(release),
    releaseOpen: () => { if (!release) throw new Error("No pending open_session"); release(); },
    delta: (text: string) => {
      const snapshot = snapshots.get("A")!;
      const assistant = snapshot.messages.find((item) => item.role === "assistant")!;
      assistant.text += text;
      emit("A", { type: "message_delta", id: assistant.id, field: "text", delta: text, revision: revision(snapshot) });
    },
    state: () => copy(snapshots.get("A")),
    waitForMonitor: () => {
      const snapshot = snapshots.get("A")!;
      snapshot.running = false;
      snapshot.backgroundWait = { waiting: true, monitorIds: ["monitor-1"] };
      emit("A", { type: "run_state", running: false });
      emit("A", { type: "background_wait_updated", backgroundWait: snapshot.backgroundWait });
    },
  },
});
localStorage.setItem("coilcoil.onboarding", JSON.stringify({ completedAt: "2026-01-01" }));
document.documentElement.dataset.platform = "darwin";
createRoot(document.getElementById("root")!).render(<StrictMode><App /><ToastHost /></StrictMode>);
