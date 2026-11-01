import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeCommand, SessionSnapshot } from "@coilcoil/runtime-protocol";
import { createPromptSubmissionHandler } from "../src/renderer/src/features/conversation/submitConversationPrompt";
import { recoverComposerSubmission, type CachedComposerDraft } from "../src/renderer/src/features/composer/useComposerController";
import { promptDocumentFromText, promptDocumentText } from "../src/renderer/src/features/composer/promptDocument";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function snapshot(name: string): SessionSnapshot {
  return { runtimeId: `runtime-${name}`, session: { id: name, path: `/sessions/${name}`, cwd: "/project", messageCount: 0 }, messages: [] } as unknown as SessionSnapshot;
}

function harness() {
  const created = deferred<SessionSnapshot>();
  const sent = deferred<unknown>();
  const calls: Array<{ command: RuntimeCommand; runtimeId?: string }> = [];
  const remembered: SessionSnapshot[] = [];
  const recovered: string[] = [];
  const state: Parameters<typeof createPromptSubmissionHandler>[0] = {
    project: { path: "/project", name: "Project", kind: "workspace" }, pendingProjectPath: "/project",
    pendingAgentMode: "standard", startingSession: false, loading: false, modelConfigured: true,
    draft: "hello", draftDocument: { version: 1, parts: [{ type: "text", text: "hello" }] }, draftImages: [],
    composerSessionKey: "pending:/project", snapshotRef: { current: undefined }, selectionRequestRef: { current: 1 },
  };
  const effects: Parameters<typeof createPromptSubmissionHandler>[1] = {
    request: <T>(command: RuntimeCommand, runtimeId?: string) => {
      calls.push({ command, runtimeId });
      return (command.type === "create_session" ? created.promise : sent.promise) as Promise<T>;
    },
    resetComposer() {}, restoreSubmission: (key) => { recovered.push(key); }, openRuntimeTab() {}, setSettingsOpen() {},
    setStartingSession() {}, scrollToBottom() {}, queue() {}, reject() {}, creationFailed() {}, error() {},
    created(next, _summary, _id, selected) {
      remembered.push(next);
      if (selected) state.snapshotRef.current = next;
    },
  };
  return { state, effects, created, sent, calls, remembered, recovered, submit: createPromptSubmissionHandler(state, effects) };
}

test("首条消息创建会话期间切走，迟到创建结果只更新后台会话并发送到原目标", async () => {
  const h = harness();
  const pending = h.submit(undefined);
  h.state.selectionRequestRef.current++;
  const selected = snapshot("B");
  h.state.snapshotRef.current = selected;
  h.created.resolve(snapshot("A"));
  h.sent.resolve(undefined);
  await pending;
  assert.equal(h.state.snapshotRef.current, selected);
  assert.equal(h.remembered[0].runtimeId, "runtime-A");
  assert.equal(h.calls[1].runtimeId, "runtime-A");
  assert.equal(h.calls[1].command.type, "prompt");
});

test("未缓存的会话仍在加载时，发送按钮不会把新消息送给上一会话", async () => {
  const h = harness();
  h.state.loading = true;
  h.state.pendingProjectPath = undefined;
  h.state.snapshotRef.current = snapshot("previous");
  h.sent.resolve(undefined);
  await h.submit(undefined);
  assert.deepEqual(h.calls, []);
});

test("后台目标发送失败时，草稿恢复以发出时的会话键寻址", async () => {
  const h = harness();
  h.state.pendingProjectPath = undefined;
  h.state.snapshotRef.current = snapshot("A");
  h.state.composerSessionKey = "/sessions/A";
  const pending = h.submit(undefined);
  h.state.selectionRequestRef.current++;
  h.state.snapshotRef.current = snapshot("B");
  h.sent.reject(new Error("offline"));
  await pending;
  assert.deepEqual(h.recovered, ["/sessions/A"]);
});

test("A发送失败时不覆盖当前B草稿，回A同时保留失败内容和后来输入的内容及图片", () => {
  const draft = (text: string, id: string): CachedComposerDraft => ({ document: promptDocumentFromText(text),
    images: [{ id, name: id, mimeType: "image/png", data: id }] });
  const cache = new Map([["A", draft("A后来输入", "new-A")]]);
  const b = draft("B正在输入", "B");
  assert.equal(recoverComposerSubmission(cache, "B", b, "A", draft("A发送失败", "old-A")), undefined);
  assert.equal(promptDocumentText(b.document), "B正在输入");
  assert.equal(promptDocumentText(cache.get("A")!.document), "A发送失败\n\nA后来输入");
  assert.deepEqual(cache.get("A")!.images.map((image) => image.id), ["old-A", "new-A"]);
  const restored = recoverComposerSubmission(cache, "B", b, "B", draft("B发送失败", "old-B"))!;
  assert.equal(promptDocumentText(restored.document), "B发送失败\n\nB正在输入");
  assert.deepEqual(restored.images.map((image) => image.id), ["old-B", "B"]);
});
