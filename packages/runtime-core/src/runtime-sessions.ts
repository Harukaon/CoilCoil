import {
  clampThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  configureHttpDispatcher,
  createAgentSession,
  createEventBus,
} from "@earendil-works/pi-coding-agent";
import {
  type ContextClearingRecord,
  type GoalState,
  type MoveSessionResult,
  type PlanApprovalState,
  type ProjectMemoryRuntimeStatus,
  type ProjectSnapshot,
  type SessionModelSelection,
  type SessionSnapshot,
  type SessionSummary,
  type ThinkingLevel,
} from "@coilcoil/runtime-protocol";
import {
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { SessionListingCache } from "./session-listing-cache.js";
import { listSessionsForCwd, type SessionListEntry } from "./session-index.js";
import {
  sessionSummary,
  subagentActivitiesFromPayload,
  titleFromText,
} from "./message-helpers.js";
import {
  directoryNodes,
} from "./project-helpers.js";
import {
  FAST_STATE_EVENT,
  GOAL_STATE_CHANNEL,
  HIDDEN_AGENT_TOOLS,
  PLAN_STATE_CHANNEL,
  CONTEXT_CLEARING_EVENT,
  CONTEXT_CLEARING_SKIPPED_EVENT,
  CONTEXT_SUMMARY_TRIM_EVENT,
  MAX_CONTEXT_CLEARINGS,
  PROJECT_MEMORY_STATUS_EVENT,
  RUNTIME_BRIDGE_STATE_EVENT,
  SUBAGENT_ACTIVITY_CHANNEL,
  projectMemoryStatusByCwd,
} from "./runtime-constants.js";
import { contextClearingRecord } from "./runtime-state.js";
import { isRecord } from "./runtime-utils.js";
import { installCompactionSettings } from "./compaction-settings.js";
import { RuntimeMcpConfig } from "./runtime-mcp-config.js";
import {
  ActiveSession,
  FastRuntimeState,
  RuntimeBridgeState,
  fastRuntimeState,
  endedGoalPayload,
  goalState,
  hydrateProjectMemoryStatus,
  mergeWorkspaceMemoryStatus,
  planApprovalState,
  projectMemoryStatus,
  runtimeBridgeState,
  shutdownAgentSession,
} from "./runtime-state.js";
import {
  ensureInside,
  errorDetail,
  errorMessage,
  safeRealPath,
} from "./runtime-utils.js";
import { rewriteSessionHeaderCwd } from "./session-relocation.js";
import { systemPromptLayerFiles } from "./system-prompt-layers.js";

export abstract class RuntimeSessions extends RuntimeMcpConfig {
  private readonly sessionListings = new SessionListingCache<SessionListEntry>();

  /**
   * The session list, read from disk only when disk has changed.
   *
   * Pi's listing streams every line of every session file, which on a few
   * hundred conversations is most of a second — and opening a workspace asks
   * for it several times over. See `session-listing-cache.ts`.
   */
  protected listSessionInfos(resolvedCwd: string): Promise<SessionListEntry[]> {
    return this.sessionListings.list(
      resolvedCwd,
      this.sessionDir,
      () => listSessionsForCwd(this.sessionDir, resolvedCwd),
    );
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const resolvedCwd = safeRealPath(cwd);
    const sessions = await this.listSessionInfos(resolvedCwd);
    const archived = this.readArchivedSessions();
    const pinned = this.readPinnedSessions();
    const mapped = sessions
      .filter((session) => !archived[safeRealPath(session.path)])
      .map((session) => {
        const path = safeRealPath(session.path);
        const pinnedAt = pinned[path];
        return {
          ...sessionSummary(session),
          ...(pinnedAt ? { pinned: true as const, pinnedAt } : {}),
        };
      })
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      });
    this.emitEvent({ type: "sessions_updated", cwd: resolvedCwd, sessions: mapped });
    return mapped;
  }

  async listArchivedSessions(cwd: string): Promise<SessionSummary[]> {
    await this.ready();
    const resolvedCwd = safeRealPath(cwd);
    const archived = this.readArchivedSessions();
    return (await this.listSessionInfos(resolvedCwd)).flatMap((session) => {
      const archivedAt = archived[safeRealPath(session.path)];
      return archivedAt ? [{ ...sessionSummary(session), archivedAt }] : [];
    });
  }

  protected async requireProjectSession(cwd: string, sessionPath: string): Promise<{ resolvedCwd: string; resolvedSession: string; }> {
    const resolvedCwd = safeRealPath(cwd);
    const resolvedSession = ensureInside(this.sessionDir, sessionPath);
    const belongsToProject = (await this.listSessionInfos(resolvedCwd))
      .some((session) => safeRealPath(session.path) === safeRealPath(resolvedSession));
    if (!belongsToProject) throw new Error("所选会话不属于当前工作区。");
    return { resolvedCwd, resolvedSession };
  }

  async archiveSession(cwd: string, sessionPath: string): Promise<SessionSummary[]> {
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const archived = this.readArchivedSessions();
    archived[safeRealPath(resolvedSession)] = new Date().toISOString();
    this.writeArchivedSessions(archived);
    const pinned = this.readPinnedSessions();
    if (pinned[safeRealPath(resolvedSession)]) {
      delete pinned[safeRealPath(resolvedSession)];
      this.writePinnedSessions(pinned);
    }
    return this.listSessions(resolvedCwd);
  }

  /** 把这些会话从归档表和置顶表里摘掉——文件都没了，记账也不该留着。 */
  private forgetSessionRecords(resolvedSessions: string[]): void {
    const targets = new Set(resolvedSessions.map((item) => safeRealPath(item)));
    const archived = this.readArchivedSessions();
    let archivedChanged = false;
    for (const key of Object.keys(archived)) {
      if (targets.has(key)) { delete archived[key]; archivedChanged = true; }
    }
    if (archivedChanged) this.writeArchivedSessions(archived);
    const pinned = this.readPinnedSessions();
    let pinnedChanged = false;
    for (const key of Object.keys(pinned)) {
      if (targets.has(key)) { delete pinned[key]; pinnedChanged = true; }
    }
    if (pinnedChanged) this.writePinnedSessions(pinned);
  }

  /**
   * 永久删除一条对话。
   *
   * 归档只是把它从列表里藏起来，文件仍然躺在会话目录里，所以工作区不用了也清不
   * 干净。用户的原话：「没有删除对话的功能，就会导致我想把这个对话删掉，但删不
   * 掉」。删不可撤销，确认放在界面那一层。
   */
  async deleteSession(cwd: string, sessionPath: string): Promise<SessionSummary[]> {
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const activeFile = this.active?.session.sessionFile ? safeRealPath(this.active.session.sessionFile) : undefined;
    if (activeFile && activeFile === safeRealPath(resolvedSession)) {
      throw new Error("该会话仍在运行，请先停止后再删除。");
    }
    this.forgetSessionRecords([resolvedSession]);
    rmSync(resolvedSession, { force: true });
    return this.listSessions(resolvedCwd);
  }

  /**
   * 删掉一个工作区的全部对话记录，含已归档的那些。
   *
   * 只动 CoilCoil 自己的会话文件；工作区目录里的代码一个字节都不碰。
   */
  async deleteWorkspaceSessions(cwd: string): Promise<{ deleted: number }> {
    const resolvedCwd = safeRealPath(cwd);
    const sessions = await this.listSessionInfos(resolvedCwd);
    const activeFile = this.active?.session.sessionFile ? safeRealPath(this.active.session.sessionFile) : undefined;
    const paths = sessions.map((session) => safeRealPath(session.path));
    if (activeFile && paths.includes(activeFile)) {
      throw new Error("该工作区里还有正在运行的会话，请先停止后再删除。");
    }
    this.forgetSessionRecords(paths);
    let deleted = 0;
    for (const path of paths) {
      rmSync(path, { force: true });
      deleted += 1;
    }
    await this.listSessions(resolvedCwd);
    return { deleted };
  }

  async restoreSession(cwd: string, sessionPath: string): Promise<SessionSummary[]> {
    const resolvedCwd = safeRealPath(cwd);
    const resolvedSession = ensureInside(this.sessionDir, sessionPath);
    const archived = this.readArchivedSessions();
    delete archived[safeRealPath(resolvedSession)];
    this.writeArchivedSessions(archived);
    return this.listSessions(resolvedCwd);
  }

  async renameSession(cwd: string, sessionPath: string, name: string): Promise<SessionSummary[]> {
    const nextName = name.replace(/[\r\n]+/g, " ").trim();
    if (!nextName) throw new Error("会话名称不能为空。");
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const activeFile = this.active?.session.sessionFile ? safeRealPath(this.active.session.sessionFile) : undefined;
    if (activeFile && activeFile === safeRealPath(resolvedSession)) {
      this.active!.session.setSessionName(nextName);
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    } else {
      SessionManager.open(resolvedSession, this.sessionDir).appendSessionInfo(nextName);
    }
    return this.listSessions(resolvedCwd);
  }

  async pinSession(cwd: string, sessionPath: string, pinned: boolean): Promise<SessionSummary[]> {
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const map = this.readPinnedSessions();
    const key = safeRealPath(resolvedSession);
    if (pinned) map[key] = new Date().toISOString();
    else delete map[key];
    this.writePinnedSessions(map);
    return this.listSessions(resolvedCwd);
  }

  async forkSession(cwd: string, sessionPath: string): Promise<{ sessions: SessionSummary[]; session: SessionSummary; }> {
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const source = (await this.listSessionInfos(resolvedCwd))
      .find((session) => safeRealPath(session.path) === safeRealPath(resolvedSession));
    if (!source) throw new Error("所选会话不属于当前工作区。");
    const forked = SessionManager.forkFrom(resolvedSession, resolvedCwd, this.sessionDir);
    const title = (source.name || titleFromText(source.firstMessage) || "对话").trim();
    forked.appendSessionInfo(`${title} (副本)`);
    const forkedPath = forked.getSessionFile();
    if (!forkedPath) throw new Error("分叉会话失败：未能创建会话文件。");
    const sessions = await this.listSessions(resolvedCwd);
    const session = sessions.find((item) => safeRealPath(item.path) === safeRealPath(forkedPath));
    if (!session) throw new Error("分叉会话已创建，但未能出现在列表中。");
    return { sessions, session };
  }

  /**
   * Move one session into another workspace.
   *
   * The caller must have released the session's runtime first: a live
   * SessionManager appends to the same file and would overwrite the relocated
   * header. Archived and pinned state is keyed by session path, which the move
   * deliberately keeps, so both survive without extra bookkeeping.
   */
  async moveSession(cwd: string, sessionPath: string, targetCwd: string): Promise<MoveSessionResult> {
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const resolvedTarget = safeRealPath(targetCwd);
    if (resolvedTarget === resolvedCwd) throw new Error("会话已经在该工作区中。");
    if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isDirectory()) {
      throw new Error("目标工作区不存在。");
    }
    const activeFile = this.active?.session.sessionFile ? safeRealPath(this.active.session.sessionFile) : undefined;
    if (activeFile && activeFile === safeRealPath(resolvedSession)) {
      throw new Error("该会话仍在运行，请先停止后再移动。");
    }
    rewriteSessionHeaderCwd(resolvedSession, resolvedTarget);
    const sessions = await this.listSessions(resolvedCwd);
    const targetSessions = await this.listSessions(resolvedTarget);
    const session = targetSessions.find((item) => safeRealPath(item.path) === safeRealPath(resolvedSession));
    if (!session) throw new Error("会话已移动，但未能出现在目标工作区中。");
    return { sessions, targetSessions, session };
  }

  async openWorkspace(cwd: string): Promise<{ sessions: SessionSummary[]; snapshot?: SessionSnapshot; }> {
    const sessions = await this.listSessions(cwd);
    const activePath = this.active?.session.sessionFile ? safeRealPath(this.active.session.sessionFile) : undefined;
    const selected = activePath
      ? sessions.find((session) => safeRealPath(session.path) === activePath)
      : undefined;
    return selected
      ? { sessions, snapshot: await this.openSession(cwd, selected.path) }
      : { sessions };
  }

  async createSession(cwd: string, selection?: SessionModelSelection): Promise<SessionSnapshot> {
    const resolvedCwd = safeRealPath(cwd);
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      throw new Error(`Project directory does not exist: ${resolvedCwd}`);
    }
    return this.installSession(resolvedCwd, SessionManager.create(resolvedCwd, this.sessionDir), selection);
  }

  async openSession(cwd: string, sessionPath: string): Promise<SessionSnapshot> {
    const resolvedCwd = safeRealPath(cwd);
    const resolvedSession = ensureInside(this.sessionDir, sessionPath);
    if (!existsSync(resolvedSession)) throw new Error("所选会话已不存在。");
    return this.installSession(resolvedCwd, SessionManager.open(resolvedSession, this.sessionDir, resolvedCwd));
  }

  protected async installSession(
    cwd: string,
    sessionManager: SessionManager,
    initialModel?: SessionModelSelection,
  ): Promise<SessionSnapshot> {
    const timingEnabled = process.env.COILCOIL_RUNTIME_TIMING === "1";
    const timingStartedAt = Date.now();
    const timings: Record<string, number> = {};
    let timingCheckpoint = timingStartedAt;
    const markTiming = (name: string): void => {
      if (!timingEnabled) return;
      const now = Date.now();
      timings[name] = now - timingCheckpoint;
      timingCheckpoint = now;
    };
    const modelRuntimeStartedAt = Date.now();
    const modelRuntimePromise = this.ready().then((runtime) => {
      if (timingEnabled) timings.modelRuntime = Date.now() - modelRuntimeStartedAt;
      return runtime;
    });
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    if (this.active) {
      const previous = this.active;
      this.active = undefined;
      previous.unsubscribe();
      await shutdownAgentSession(previous.session, "quit").catch(() => undefined);
      previous.eventBus.clear();
    }

    const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: true });
    // Pi's compaction budget is two absolute token counts that never look at the
    // model. Bind it to the window the session is actually running under, which
    // the session itself reports once it exists.
    let compactionModelSource: { model?: { contextWindow: number } } | undefined;
    installCompactionSettings(settingsManager, () => compactionModelSource?.model?.contextWindow);
    configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
    const eventBus = createEventBus();
    let installedActive: ActiveSession | undefined;
    let pendingContextClearings: ContextClearingRecord[] = [];
    let pendingBridgeState: RuntimeBridgeState | undefined;
    let pendingFastState: FastRuntimeState | undefined;
    let pendingMemoryStatus: ProjectMemoryRuntimeStatus | undefined;
    let pendingPlanApproval: PlanApprovalState | undefined;
    let pendingGoal: GoalState | undefined;
    eventBus.on(RUNTIME_BRIDGE_STATE_EVENT, (value) => {
      const next = runtimeBridgeState(value);
      if (!next) return;
      pendingBridgeState = next;
      if (!installedActive) return;
      installedActive.bridgeState = next;
      this.publishRuntimeInspection(installedActive);
    });
    eventBus.on(FAST_STATE_EVENT, (value) => {
      const next = fastRuntimeState(value);
      if (!next) return;
      pendingFastState = next;
      if (!installedActive) return;
      installedActive.fastState = next;
      this.emitEvent({ type: "session_fast_updated", fast: next.enabled });
    });
    /* 压缩这几条一定要带会话标识。
       「一个压缩周期里只清理一次」这条规矩，事后只能靠日志复核；而清理配额在换会话
       （session_start / session_tree / session_shutdown）时也会重置，所以同一条流里
       连着两次清理，可能是违规，也可能只是换了个对话——记录里没有会话标识就分不出
       来，这正是 2026-09-18 复核时卡住的地方。 */
    const compactionLogContext = (): { sessionPath?: string } => ({
      sessionPath: installedActive?.session.sessionFile ?? undefined,
    });
    eventBus.on(CONTEXT_CLEARING_EVENT, (value) => {
      // Every decision is logged, including the ones that cleared nothing: this
      // stage is invisible in the UI by design, so the log is the only place it
      // can be told apart from "never fired".
      if (isRecord(value)) {
        this.log.info("compaction", "context_clearing", {
          clearedResults: value.clearedResults,
          freedTokens: value.freedTokens,
          contextTokens: value.contextTokens,
          contextWindow: value.contextWindow,
          // 这一条是长会话唯一要看的：清完还落在我们的线下面吗？落不回去，
          // 下一步就是 pi 的有损摘要。
          fitsAgain: value.fitsAgain,
        }, compactionLogContext());
      }
      // Clearing runs while a request is being built, which can be before the
      // active session is installed, so the record is held until it is.
      const next = contextClearingRecord(value);
      if (!next) return;
      pendingContextClearings = [...pendingContextClearings, next].slice(-MAX_CONTEXT_CLEARINGS);
      if (!installedActive) return;
      installedActive.contextClearings = pendingContextClearings;
      this.publishRuntimeInspection(installedActive);
    });
    // 只进日志的两条：一条记「交给 pi 去摘要的那一段瘦了多少」，一条记「到线了却
    // 没动手，为什么」。界面上不画线——它们都没有改变对话本身——可压缩挂掉的时候，
    // 「那一发到底多大、还在不在窗口里」是唯一说得清原因的数。
    eventBus.on(CONTEXT_SUMMARY_TRIM_EVENT, (value) => {
      if (!isRecord(value)) return;
      const count = (candidate: unknown): number => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
      const window = count(value.contextWindow);
      const after = count(value.tokensAfter);
      this.log.log(window > 0 && after > window ? "error" : "info", "compaction", "summary_trim", {
        historyMessages: value.historyMessages,
        turnPrefixMessages: value.turnPrefixMessages,
        clearedResults: value.clearedResults,
        tokensBefore: value.tokensBefore,
        tokensAfter: value.tokensAfter,
        contextWindow: value.contextWindow,
        // 瘦完还超窗口，那这一发注定被上游顶回来——这一条是 error，别埋在 info 里。
        fitsWindow: window <= 0 ? undefined : after <= window,
      }, compactionLogContext());
    });
    eventBus.on(CONTEXT_CLEARING_SKIPPED_EVENT, (value) => {
      if (!isRecord(value)) return;
      this.log.info("compaction", "clearing_skipped", {
        reason: value.reason,
        contextTokens: value.contextTokens,
        contextWindow: value.contextWindow,
        freedTokens: value.freedTokens,
      }, compactionLogContext());
    });
    eventBus.on(PROJECT_MEMORY_STATUS_EVENT, (value) => {
      const parsed = projectMemoryStatus(value);
      const next = parsed ? hydrateProjectMemoryStatus({ ...parsed, cwd: parsed.cwd || cwd }) : undefined;
      if (!next) return;
      const previous = installedActive?.memoryStatus ?? pendingMemoryStatus;
      pendingMemoryStatus = next;
      const memoryKey = safeRealPath(next.cwd);
      projectMemoryStatusByCwd.set(
        memoryKey,
        mergeWorkspaceMemoryStatus(projectMemoryStatusByCwd.get(memoryKey), next),
      );
      if (!installedActive) return;
      installedActive.memoryStatus = next;
      this.publishRuntimeInspection(installedActive);
      if (next.source !== "manual" || previous?.state === next.state) return;
      if (next.state === "running") this.emitEvent({ type: "runtime_notice", level: "info", message: next.message || "正在整理当前项目记忆…" });
      else if (next.state === "succeeded") this.emitEvent({ type: "runtime_notice", level: "success", message: next.message || "项目记忆整理完成" });
      else if (next.state === "busy") this.emitEvent({ type: "runtime_notice", level: "info", message: next.message || "当前项目已有记忆整理正在运行" });
      else if (next.state === "failed") this.emitEvent({ type: "runtime_notice", level: "error", message: next.error || "项目记忆整理失败" });
    });
    eventBus.on(GOAL_STATE_CHANNEL, (value) => {
      // The channel carries the loop the session is in, and null once it ends.
      // An explicit finished status says the same thing; anything else we cannot
      // read is junk, and junk must not wipe a loop that is still running.
      const next = goalState(value);
      if (!next && value !== null && value !== undefined && !endedGoalPayload(value)) return;
      pendingGoal = next;
      if (!installedActive) return;
      installedActive.goal = next;
      this.emitEvent({ type: "goal_updated", goal: next });
    });
    eventBus.on(PLAN_STATE_CHANNEL, (value) => {
      const next = planApprovalState(value);
      if (value !== null && value !== undefined && !next) return;
      pendingPlanApproval = next;
      if (!installedActive) return;
      installedActive.planApproval = next;
      installedActive.project = { ...installedActive.project, planApproval: next, refreshedAt: Date.now() };
      this.emitEvent({ type: "plan_approval_updated", plan: next });
      this.emitEvent({ type: "project_updated", project: installedActive.project });
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      eventBus,
      additionalExtensionPaths: this.extensionPaths,
      additionalSkillPaths: this.skillPaths,
      additionalPromptTemplatePaths: this.promptPaths,
      noExtensions: true,
      noThemes: true,
      // CoilCoil treats SYSTEM.md as an additive global/project layer. Pi's
      // native discovery replaces the base prompt and only selects one scope.
      systemPromptOverride: () => undefined,
      appendSystemPrompt: systemPromptLayerFiles({
        agentDir: this.agentDir,
        cwd,
        projectTrusted: settingsManager.isProjectTrusted(),
      }),
    });
    await this.refreshAgentMcpConfiguration(eventBus, cwd);
    const resourceLoaderStartedAt = Date.now();
    const resourceLoaderPromise = loader.reload().then(() => {
      if (timingEnabled) timings.resourceLoader = Date.now() - resourceLoaderStartedAt;
    });
    const [modelRuntime] = await Promise.all([modelRuntimePromise, resourceLoaderPromise]);
    timingCheckpoint = Date.now();
    const selectedModel = initialModel
      ? modelRuntime.getModel(initialModel.provider, initialModel.modelId)
      : undefined;
    if (initialModel && !selectedModel) {
      throw new Error(`Unknown model: ${initialModel.provider}/${initialModel.modelId}`);
    }
    if (selectedModel && !(await modelRuntime.checkAuth(selectedModel.provider))) {
      throw new Error(`No credential is configured for ${selectedModel.provider}.`);
    }
    const effectiveInitialModel = selectedModel ? this.modelWithRuntimeOptions(selectedModel) : undefined;
    const effectiveInitialThinkingLevel = effectiveInitialModel && initialModel
      ? clampThinkingLevel(effectiveInitialModel, initialModel.thinkingLevel) as ThinkingLevel
      : undefined;
    const extensionErrors = loader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      const message = extensionErrors.map((entry) => `${entry.path}: ${entry.error}`).join("\n");
      throw new Error(`CoilCoil workflow failed to load:\n${message}`);
    }
    if (timingEnabled) {
      for (const extension of loader.getExtensions().extensions) {
        const handlers = extension.handlers.get("session_start");
        if (!handlers?.length) continue;
        extension.handlers.set("session_start", handlers.map((handler, index) => (async (...args: Parameters<typeof handler>) => {
          const startedAt = Date.now();
          try {
            return await handler(...args);
          } finally {
            process.stderr.write(`[coilcoil-runtime-timing] ${JSON.stringify({ extension: extension.path, event: "session_start", handler: index, elapsedMs: Date.now() - startedAt })}\n`);
          }
        }) as typeof handler));
      }
    }

    const created = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader: loader,
      model: effectiveInitialModel,
      thinkingLevel: effectiveInitialThinkingLevel,
      // Excluding here rather than deactivating afterwards is what keeps the
      // guidelines out too: the system prompt is built during bindExtensions,
      // before any later `setActiveToolsByName` could take them back out.
      excludeTools: [...HIDDEN_AGENT_TOOLS],
    });
    markTiming("createAgentSession");
    compactionModelSource = created.session;
    await created.session.bindExtensions({});
    markTiming("bindExtensions");
    if (created.session.model) {
      const effectiveModel = this.modelWithRuntimeOptions(created.session.model);
      if (effectiveModel !== created.session.model) await created.session.setModel(effectiveModel);
    }
    created.session.setActiveToolsByName(created.session.getActiveToolNames().filter((name) => name !== "find"));
    const activeToolNames = new Set(created.session.getActiveToolNames());
    const requiredTools = ["read", "bash", "edit", "write", "grep", "ls", "todo", "terminal", "mcp"];
    // Pi only builds the PowerShell tool on Windows, where CoilCoil asks the
    // Agent to prefer it over the Bash-flavoured shell tool.
    if (process.platform === "win32") requiredTools.push("powershell");
    const missingTools = requiredTools.filter((name) => !activeToolNames.has(name));
    if (missingTools.length > 0) {
      await shutdownAgentSession(created.session, "quit").catch(() => undefined);
      throw new Error(`CoilCoil workflow did not activate required tools: ${missingTools.join(", ")}`);
    }

    const reconstructed = this.reconstructState(created.session);
    const files = await directoryNodes(cwd);
    markTiming("restoreAndFiles");
    const project: ProjectSnapshot = {
      cwd,
      files,
      changes: [],
      terminals: [...reconstructed.terminals.values()],
      plan: reconstructed.plan,
      planApproval: reconstructed.planApproval ?? pendingPlanApproval,
      refreshedAt: Date.now(),
    };
    const active: ActiveSession = {
      cwd,
      session: created.session,
      unsubscribe: () => undefined,
      tools: reconstructed.tools,
      subagents: reconstructed.subagents,
      terminals: reconstructed.terminals,
      plan: reconstructed.plan,
      project,
      messageIds: new WeakMap(),
      messageRevision: 0,
      pendingUserPrompts: [],
      promptQueue: [],
      steeringMessages: [],
      promptDrainInProgress: false,
      nextTimelineOrder: reconstructed.nextTimelineOrder,
      toolRunIds: reconstructed.toolRunIds,
      responseMetrics: reconstructed.responseMetrics,
      responseMetricsHistory: reconstructed.responseMetricsHistory,
      sessionRevision: 1,
      contextClearings: pendingContextClearings,
      bridgeState: pendingBridgeState,
      fastState: pendingFastState,
      memoryStatus: pendingMemoryStatus ?? projectMemoryStatusByCwd.get(safeRealPath(cwd)),
      planApproval: reconstructed.planApproval ?? pendingPlanApproval,
      goal: pendingGoal,
      eventBus,
    };
    installedActive = active;
    this.active = active;
    active.unsubscribe = created.session.subscribe((event) => this.handleSessionEvent(event));
    eventBus.on(SUBAGENT_ACTIVITY_CHANNEL, (raw) => {
      if (this.active !== active) return;
      this.mergeSubagentActivities(subagentActivitiesFromPayload(raw));
    });
    const snapshot = await this.snapshot(reconstructed);
    markTiming("snapshot");
    this.emitEvent({ type: "session_snapshot", snapshot });
    void this.refreshRuntimeInspectionSources(active);
    setTimeout(() => {
      if (this.active !== active) return;
      void this.refreshProject().catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      });
      void this.listSessions(cwd).catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      });
    }, 0);
    if (timingEnabled) {
      process.stderr.write(`[coilcoil-runtime-timing] ${JSON.stringify({ cwd, totalMs: Date.now() - timingStartedAt, ...timings })}\n`);
    }
    return snapshot;
  }
}
