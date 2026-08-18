import {
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import {
  type FileNode,
  type ProjectSnapshot,
  type PromptImage,
  type RuntimeInspectionSnapshot,
  type RuntimeSkillState,
  type RuntimeToolDefinition,
  type SessionSnapshot,
  type SessionSummary,
  type ThinkingLevel,
  summarizeCacheUsage,
} from "@suocode/runtime-protocol";
import {
  existsSync,
  statSync,
} from "node:fs";
import {
  readFile,
  stat,
} from "node:fs/promises";
import {
  relative,
  resolve,
} from "node:path";
import {
  preparePromptImages,
  titleFromText,
} from "./message-helpers.js";
import {
  directoryNodes,
  gitChanges,
} from "./project-helpers.js";
import {
  ORIGINAL_SESSION_MUTATION_UNSUPPORTED,
  projectMemoryStatusByCwd,
} from "./runtime-constants.js";
import {
  buildRuntimeInspection,
} from "./runtime-inspection.js";
import { RuntimeSessionEvents } from "./runtime-session-events.js";
import {
  ActiveSession,
  ReconstructedSessionState,
  hydrateProjectMemoryStatus,
  memoryStatusForInspection,
  shutdownAgentSession,
} from "./runtime-state.js";
import {
  ensureInside,
  errorDetail,
  errorMessage,
  estimatedTextTokens,
  isRecord,
  safeRealPath,
} from "./runtime-utils.js";
import {
  sessionUsage,
} from "./session-values.js";
import {
  buildRuntimeTokenBreakdown,
  runtimeToolCategory,
  runtimeToolDefinitionTokens,
} from "./runtime-token-breakdown.js";

export class SuoCodeRuntime extends RuntimeSessionEvents {
  async prompt(text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (prompt === "/memory" && !images?.length) return this.runMemoryNow();
    if (active.session.isStreaming || this.promptStarting || active.promptQueue.length > 0) {
      this.enqueuePrompt(active, prompt, images, clientMessageId);
      return { accepted: true };
    }
    await this.startPrompt(active, prompt, images, clientMessageId, false);
    return { accepted: true };
  }

  async rewindPrompt(entryId: string, text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (active.session.isStreaming) throw new Error("请等待当前回复结束后再回溯。");
    if (this.promptStarting) throw new Error("上一条消息正在启动，请稍候。");
    this.promptStarting = true;
    try {
      await this.applyPendingSessionModel(active);
      const result = await active.session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("未能回溯到所选消息。");
      active.sessionRevision += 1;
      active.summaryActivity = undefined;
      const prepared = await preparePromptImages(images);
      const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
      const hasUserMessage = active.session.messages.some((message) => isRecord(message) && message.role === "user");
      if (!hasUserMessage) active.session.setSessionName(titleFromText(prompt));
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
      // Session-scoped System Prompt, Skill, and MCP policies live on the active
      // Pi branch. Rewinding changes that branch, so refresh the right-hand
      // runtime inspector without blocking the new prompt on MCP discovery.
      void this.refreshRuntimeInspectionSources(active);
      this.queueClientMessage(active, clientMessageId);
      void active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        preflightResult: () => { this.promptStarting = false; },
      }).catch((error) => {
        this.promptStarting = false;
        this.rejectClientMessage(active, clientMessageId);
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
        this.emitEvent({ type: "run_state", running: false });
      });
      return { accepted: true };
    } catch (error) {
      this.promptStarting = false;
      throw error;
    }
  }

  async steer(text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true; }> {
    // Keep the legacy wire command compatible, but never let it bypass SuoCode's
    // per-session FIFO semantics by inserting work into Pi's active turn.
    return this.prompt(text, images, clientMessageId);
  }

  async abort(): Promise<{ aborted: boolean; }> {
    const active = this.requireActive();
    if (!active.session.isStreaming) return { aborted: false };
    await active.session.abort();
    return { aborted: true };
  }

  protected requireActive(): ActiveSession {
    if (!this.active) throw new Error("请先打开项目并创建会话。");
    return this.active;
  }

  async refreshProject(): Promise<ProjectSnapshot> {
    const active = this.requireActive();
    const [files, changes] = await Promise.all([directoryNodes(active.cwd), gitChanges(active.cwd)]);
    active.project = {
      cwd: active.cwd,
      files,
      changes,
      terminals: [...active.terminals.values()].sort((a, b) => b.startedAt - a.startedAt),
      plan: [...active.plan],
      planApproval: active.planApproval,
      refreshedAt: Date.now(),
    };
    this.emitEvent({ type: "project_updated", project: active.project });
    return active.project;
  }

  async listProjectDirectory(path: string): Promise<FileNode[]> {
    const active = this.requireActive();
    return directoryNodes(active.cwd, path);
  }

  protected publishProjectFromMemory(): void {
    const active = this.active;
    if (!active) return;
    active.project = {
      ...active.project,
      terminals: [...active.terminals.values()].sort((a, b) => b.startedAt - a.startedAt),
      plan: [...active.plan],
      planApproval: active.planApproval,
      refreshedAt: Date.now(),
    };
    this.emitEvent({ type: "project_updated", project: active.project });
  }

  protected scheduleProjectRefresh(): void {
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    this.projectRefreshTimer = setTimeout(() => {
      void this.refreshProject().catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      });
    }, 180);
  }

  async readProjectFile(path: string, maxBytes = 512 * 1024): Promise<{ path: string; content: string; truncated: boolean; }> {
    const active = this.requireActive();
    const target = ensureInside(active.cwd, path);
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new Error("所选路径不是文件。");
    const buffer = await readFile(target);
    const limit = Math.max(1, Math.min(maxBytes, 2 * 1024 * 1024));
    const truncated = buffer.byteLength > limit;
    const content = buffer.subarray(0, limit).toString("utf8");
    return { path: relative(active.cwd, target), content, truncated };
  }

  async snapshot(reconstructedState?: ReconstructedSessionState): Promise<SessionSnapshot> {
    const active = this.requireActive();
    const reconstructed = reconstructedState ?? this.reconstructState(active.session);
    const header = active.session.sessionManager.getHeader();
    const now = new Date();
    const sessionFile = active.session.sessionFile ?? "";
    let updatedAt = now.toISOString();
    if (sessionFile && existsSync(sessionFile)) {
      try {
        updatedAt = statSync(sessionFile).mtime.toISOString();
      } catch {
        // The session may be between an atomic write and rename; the live timestamp is sufficient.
      }
    }
    const firstUserMessage = reconstructed.messages.find((message) => message.role === "user");
    const summary: SessionSummary = {
      id: active.session.sessionId,
      path: sessionFile,
      cwd: active.cwd,
      title: active.session.sessionName || titleFromText(firstUserMessage?.text ?? ""),
      createdAt: header?.timestamp ?? now.toISOString(),
      updatedAt,
      messageCount: active.session.messages.length,
    };
    const messages = reconstructed.messages;
    if (active.activeAssistantMessage && !messages.some((message) => message.id === active.activeAssistantMessage!.id)) {
      const maxOrder = messages.reduce((max, message) => Math.max(max, message.order), -1);
      messages.push({ ...active.activeAssistantMessage, order: maxOrder + 1 });
    }
    const model = active.session.model;
    const usage = sessionUsage(active.session);
    active.responseMetrics = reconstructed.responseMetrics ?? active.responseMetrics;
    active.responseMetricsHistory = reconstructed.responseMetricsHistory;
    const projectedTools = new Map(reconstructed.tools);
    // A running tool has no toolResult yet, so branch reconstruction cannot see
    // it. Preserve the live projection across Renderer reconnects and HMR.
    for (const [id, tool] of active.tools) {
      if (tool.status === "running") projectedTools.set(id, { ...tool, args: { ...tool.args } });
    }
    return {
      messageRevision: active.messageRevision,
      session: summary,
      messages,
      promptQueue: active.promptQueue.map((item) => ({
        ...item,
        images: item.images?.map((image) => ({ ...image })),
      })),
      tools: [...projectedTools.values()].sort((a, b) => a.order - b.order),
      subagents: [...active.subagents.values()].sort((left, right) => left.updatedAt - right.updatedAt || left.index - right.index),
      project: active.project,
      model: model
        ? { provider: model.provider, id: model.id, name: model.name || model.id, reasoning: Boolean(model.reasoning) }
        : undefined,
      pendingModel: active.pendingModel,
      thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
      fast: active.fastState?.enabled ?? false,
      responseMetrics: active.responseMetrics,
      responseMetricsHistory: active.responseMetricsHistory,
      contextUsage: usage.contextUsage,
      tokenUsage: usage.tokenUsage,
      runtimeInspection: this.runtimeInspection(active),
      running: active.session.isStreaming || this.promptStarting || active.promptQueue.length > 0,
    };
  }

  protected runtimeInspection(active: ActiveSession): RuntimeInspectionSnapshot {
    const base = buildRuntimeInspection(
      active.session.sessionManager,
      active.sessionRevision,
      active.summaryActivity,
    );
    const messages: readonly unknown[] = active.session.isStreaming && active.bridgeState?.contextMessages?.length
      ? active.bridgeState.contextMessages
      : active.session.messages;
    const estimatedMessages = messages.reduce<number>((total, message) => {
      try {
        return total + estimateTokens(message as Parameters<typeof estimateTokens>[0]);
      } catch {
        return total + estimatedTextTokens(message);
      }
    }, 0);
    const activeToolNames = new Set(active.session.getActiveToolNames());
    const mcpServerNames = active.mcpStatus?.servers.map((server) => server.name) ?? [];
    const tools: RuntimeToolDefinition[] = active.session.getAllTools().map((tool) => {
      const source = tool.sourceInfo.source || tool.sourceInfo.path || "unknown";
      const category = runtimeToolCategory(tool, mcpServerNames);
      return {
        name: tool.name,
        description: tool.description,
        source,
        active: activeToolNames.has(tool.name),
        category,
        estimatedTokens: runtimeToolDefinitionTokens(tool),
      };
    }).sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
    const disabledSkills = new Set(active.bridgeState?.disabledSkills ?? []);
    const readSkills = new Set((active.bridgeState?.readSkills ?? []).map((path) => resolve(path)));
    const skills: RuntimeSkillState[] = (active.skillConfiguration?.skills ?? []).map((skill) => {
      const resolvedPath = resolve(skill.filePath);
      const sessionEnabled = skill.enabled && !disabledSkills.has(skill.filePath) && !disabledSkills.has(resolvedPath);
      return {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        source: skill.source,
        globallyEnabled: skill.enabled,
        sessionEnabled,
        publishedToModel: sessionEnabled && !skill.disableModelInvocation,
        readInSession: readSkills.has(resolvedPath),
        estimatedMetadataTokens: estimatedTextTokens({
          name: skill.name,
          description: skill.description,
          location: skill.filePath,
        }),
      };
    });
    const effectiveSystemPrompt = active.bridgeState?.effectiveSystemPrompt || active.session.systemPrompt || undefined;
    const systemPromptTokens = effectiveSystemPrompt ? estimatedTextTokens(effectiveSystemPrompt) : undefined;
    const toolDefinitionTokens = tools.filter((tool) => tool.active).reduce((total, tool) => total + tool.estimatedTokens, 0);
    const tokenBreakdown = buildRuntimeTokenBreakdown(
      messages,
      systemPromptTokens ?? 0,
      tools,
      mcpServerNames,
    );
    const usage = sessionUsage(active.session);
    // A lifetime average permanently penalizes a healthy session for its first
    // cache-building request. Pi's own footer reports the latest request, while
    // billing totals below continue to include every provider response.
    const latestCache = active.responseMetrics
      ? summarizeCacheUsage(
        active.responseMetrics.inputTokens,
        active.responseMetrics.cacheReadTokens,
        active.responseMetrics.cacheWriteTokens,
      )
      : undefined;
    const cacheHitRate = latestCache && (latestCache.cacheReadTokens > 0 || latestCache.cacheWriteTokens > 0)
      ? latestCache.hitRate
      : undefined;
    const sharedMemoryStatus = projectMemoryStatusByCwd.get(safeRealPath(active.cwd));
    const memoryStatus = memoryStatusForInspection(active.memoryStatus, sharedMemoryStatus);
    return {
      ...base,
      effectiveSystemPrompt,
      systemPromptOverride: Boolean(active.bridgeState?.systemPromptOverride),
      estimates: {
        systemPrompt: systemPromptTokens,
        toolDefinitions: toolDefinitionTokens || undefined,
        messages: estimatedMessages || undefined,
        total: usage.contextUsage?.tokens ?? (((systemPromptTokens ?? 0) + toolDefinitionTokens + estimatedMessages) || undefined),
      },
      cacheHitRate,
      tokenBreakdown,
      tools,
      skills,
      mcp: active.mcpStatus,
      memory: memoryStatus ? hydrateProjectMemoryStatus(memoryStatus) : undefined,
      capabilities: {
        editSystemPrompt: true,
        removeOriginalSessionItems: false,
        removeOriginalSessionItemsReason: ORIGINAL_SESSION_MUTATION_UNSUPPORTED,
      },
    };
  }

  protected publishRuntimeInspection(active: ActiveSession): void {
    this.emitEvent({ type: "runtime_inspection_updated", inspection: this.runtimeInspection(active) });
  }

  async dispose(): Promise<void> {
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    if (this.mcpReloadTimer) clearTimeout(this.mcpReloadTimer);
    if (this.resourceReloadTimer) clearTimeout(this.resourceReloadTimer);
    for (const flow of this.providerAuthFlows.values()) {
      const pending = this.clearProviderAuthPrompt(flow);
      flow.controller.abort();
      pending?.reject(new Error("运行时已关闭，订阅登录已取消。"));
    }
    this.providerAuthFlows.clear();
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      active.unsubscribe();
      try {
        await shutdownAgentSession(active.session, "quit");
      } finally {
        active.eventBus.clear();
      }
    }
  }
}
