import {
  DefaultPackageManager,
  type EventBusController,
  SettingsManager,
  loadSkills,
} from "@earendil-works/pi-coding-agent";
import {
  type MemoryConfigurationSnapshot,
  type MemorySettings,
  type SaveMemoryConfigurationInput,
  type SkillConfigurationSnapshot,
  type SkillDiagnostic,
  type SkillEntry,
  type SkillSource,
} from "@suocode/runtime-protocol";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  homedir,
} from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  listProjectMemoryDocuments,
  PROJECT_MEMORY_FILE,
  readMemoryDocument,
} from "./memory-documents.js";
import {
  loadMcpAdapterConfigModule,
  mcpAgentConfigRegistry,
  mcpConfigurationForAgent,
  withBundledBrowserMcp,
} from "./browser-mcp.js";
import { RuntimeProviderAuth } from "./runtime-provider-auth.js";
import {
  ActiveSession,
} from "./runtime-state.js";
import {
  errorDetail,
  errorMessage,
  recordOfStrings,
  safeRealPath,
} from "./runtime-utils.js";
import {
  deleteInvalidManagedSkill,
  validateSkillImport,
} from "./skill-import-validation.js";
import {
  removeSkillOverride,
  rewriteSkillOverridePaths,
  skillIsRemoved,
  skillOverridePattern,
  skillPatternBaseDir,
} from "./skill-overrides.js";

export abstract class RuntimeResourcesController extends RuntimeProviderAuth {
  private static readonly defaultMemoryGenerationRules = "只记录跨会话仍会复用的稳定事实、项目约定和用户长期偏好；不要记录临时进度、一次性错误、通用知识或任何密码、API Key、Token、Cookie、私钥和 Authorization。";

  private memorySettingsPath(): string {
    return join(this.agentDir, "memory-settings.json");
  }

  private memoryStorageRoot(): string {
    const configured = process.env.PI_PROJECT_MEMORY_DIR?.trim();
    const expanded = configured === "~"
      ? homedir()
      : configured?.startsWith("~/")
        ? join(homedir(), configured.slice(2))
        : configured;
    return resolve(expanded || join(this.agentDir, "memory"));
  }

  private normalizeMemorySettings(value: unknown): MemorySettings {
    const record = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const integer = (key: string, fallback: number): number => {
      const number = record[key];
      return typeof number === "number" && Number.isFinite(number)
        ? Math.min(1_000_000, Math.max(100, Math.round(number)))
        : fallback;
    };
    const rules = typeof record.generationRules === "string" && record.generationRules.trim()
      ? record.generationRules.trim().slice(0, 20_000)
      : RuntimeResourcesController.defaultMemoryGenerationRules;
    return {
      version: 1,
      projectMaxChars: integer("projectMaxChars", 1_000),
      globalMaxChars: integer("globalMaxChars", 2_000),
      generationRules: rules,
      autoSummarize: record.autoSummarize !== false,
      globalEnabled: record.globalEnabled !== false,
      projectEnabled: record.projectEnabled !== false,
    };
  }

  private readMemorySettings(): MemorySettings {
    const path = this.memorySettingsPath();
    if (!existsSync(path)) return this.normalizeMemorySettings(undefined);
    try {
      return this.normalizeMemorySettings(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return this.normalizeMemorySettings(undefined);
    }
  }

  private writeMemorySettings(settings: MemorySettings): void {
    const path = this.memorySettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  }

  private memoryProjectRoot(cwd: string): string {
    let current = safeRealPath(cwd);
    while (true) {
      if (existsSync(join(current, ".git"))) return current;
      const parent = dirname(current);
      if (parent === current) return safeRealPath(cwd);
      current = parent;
    }
  }


  async getMemoryConfiguration(cwd?: string): Promise<MemoryConfigurationSnapshot> {
    const settings = this.readMemorySettings();
    const storageRoot = this.memoryStorageRoot();
    const globalFile = join(storageRoot, "GLOBAL.md");
    const global = readMemoryDocument("global", "全局记忆", globalFile, storageRoot, settings.globalMaxChars);
    const resolvedCwd = this.mcpCwd(cwd);
    const projectRoot = this.memoryProjectRoot(resolvedCwd);
    const projectName = basename(projectRoot) || "root";
    const projectDirectory = join(storageRoot, projectName);
    const project = readMemoryDocument(
      "project",
      projectName,
      join(projectDirectory, PROJECT_MEMORY_FILE),
      projectDirectory,
      settings.projectMaxChars,
      projectRoot,
      projectName,
    );
    return {
      settings,
      settingsFile: this.memorySettingsPath(),
      storageRoot,
      global,
      project,
      projects: listProjectMemoryDocuments(storageRoot, settings.projectMaxChars, project),
    };
  }

  async saveMemoryConfiguration(input: SaveMemoryConfigurationInput, cwd?: string): Promise<MemoryConfigurationSnapshot> {
    if (!input || typeof input !== "object") throw new Error("记忆配置无效。");
    const settings = this.normalizeMemorySettings(input.settings);
    if (typeof input.globalContent !== "string") throw new Error("全局记忆内容无效。");
    if (input.projectContent !== undefined && typeof input.projectContent !== "string") {
      throw new Error("项目记忆内容无效。");
    }
    const projectEdits = input.projectContents ?? [];
    if (!Array.isArray(projectEdits) || projectEdits.some((edit) => (
      !edit || typeof edit.filePath !== "string" || typeof edit.content !== "string"
    ))) {
      throw new Error("项目记忆内容无效。");
    }
    const configuration = await this.getMemoryConfiguration(cwd);
    const writeMemory = (path: string, content: string): void => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, path);
    };
    writeMemory(configuration.global.filePath, input.globalContent);
    if (configuration.project && input.projectContent !== undefined) {
      writeMemory(configuration.project.filePath, input.projectContent);
    }
    // Only paths this store itself listed may be written, so an edit can never
    // reach outside the memory directory however it was addressed.
    for (const edit of projectEdits) {
      const target = configuration.projects.find((document) => document.filePath === edit.filePath);
      if (!target) throw new Error(`未知的项目记忆：${edit.filePath}`);
      writeMemory(target.filePath, edit.content);
    }
    this.writeMemorySettings(settings);
    this.reloadActiveSessionResources("记忆设置重新加载失败");
    return this.getMemoryConfiguration(cwd);
  }

  protected mcpCwd(cwd?: string): string {
    return cwd ? safeRealPath(cwd) : this.active?.cwd ?? process.cwd();
  }

  protected archivedSessionsPath(): string {
    return join(this.agentDir, "archived-sessions.json");
  }

  protected pinnedSessionsPath(): string {
    return join(this.agentDir, "pinned-sessions.json");
  }

  protected readArchivedSessions(): Record<string, string> {
    return this.readPathTimestampMap(this.archivedSessionsPath());
  }

  protected writeArchivedSessions(value: Record<string, string>): void {
    this.writePathTimestampMap(this.archivedSessionsPath(), value);
  }

  protected readPinnedSessions(): Record<string, string> {
    return this.readPathTimestampMap(this.pinnedSessionsPath());
  }

  protected writePinnedSessions(value: Record<string, string>): void {
    this.writePathTimestampMap(this.pinnedSessionsPath(), value);
  }

  protected readPathTimestampMap(path: string): Record<string, string> {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return recordOfStrings(parsed);
    } catch {
      return {};
    }
  }

  protected writePathTimestampMap(path: string, value: Record<string, string>): void {
    mkdirSync(this.agentDir, { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  }

  protected reloadMcpExtension(): void {
    this.reloadActiveSessionResources("MCP 扩展重新加载失败");
  }

  protected async refreshAgentMcpConfiguration(eventBus: EventBusController, cwd: string): Promise<void> {
    const adapter = await loadMcpAdapterConfigModule();
    const resolvedCwd = this.mcpCwd(cwd);
    this.cleanRemovedMcpServerState(adapter, resolvedCwd);
    const configPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    // The workspace's own servers live in SuoCode's agent directory, so they are
    // merged here rather than read back out of the workspace by the adapter.
    const configuration = this.withWorkspaceMcpServers(adapter.loadMcpConfig(configPath, resolvedCwd), resolvedCwd);
    const hiddenNames = new Set([
      ...this.readRemovedMcpServers(),
      ...this.readDisabledMcpServers(),
    ]);
    mcpAgentConfigRegistry().set(eventBus, withBundledBrowserMcp(
      mcpConfigurationForAgent(configuration, hiddenNames),
      process.env,
      this.browserScopeId,
    ));
  }

  protected async reloadActiveSessionNow(active: ActiveSession): Promise<void> {
    await this.refreshAgentMcpConfiguration(active.eventBus, active.cwd);
    await active.session.reload();
    if (this.active !== active) return;
    this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    await this.refreshRuntimeInspectionSources(active);
  }

  protected async reloadMcpExtensionNow(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!this.canReloadActiveSession(active)) {
      this.reloadMcpExtension();
      return;
    }
    if (this.resourceReloadTimer) clearTimeout(this.resourceReloadTimer);
    this.resourceReloadTimer = undefined;
    await this.reloadActiveSessionNow(active);
  }

  protected canReloadActiveSession(active: ActiveSession): boolean {
    if (active.session.isStreaming) return false;
    return ![...active.subagents.values()].some((subagent) =>
      (subagent.status === "pending" || subagent.status === "running") && subagent.controlReady === true,
    );
  }

  protected reloadActiveSessionResources(errorLabel = "资源重新加载失败"): void {
    if (this.resourceReloadTimer) clearTimeout(this.resourceReloadTimer);
    if (this.mcpReloadTimer) clearTimeout(this.mcpReloadTimer);
    this.mcpReloadTimer = undefined;
    const active = this.active;
    if (!active) return;
    const attemptReload = (): void => {
      this.resourceReloadTimer = undefined;
      if (this.active !== active) return;
      if (!this.canReloadActiveSession(active)) {
        this.resourceReloadTimer = setTimeout(attemptReload, 750);
        return;
      }
      void this.reloadActiveSessionNow(active)
        .catch((error) => {
          this.emitEvent({ type: "runtime_error", message: `${errorLabel}：${errorMessage(error)}`, detail: errorDetail(error) });
        });
    };
    this.resourceReloadTimer = setTimeout(attemptReload, 750);
  }

  protected skillSettingsManager(cwd?: string): SettingsManager {
    return SettingsManager.create(this.mcpCwd(cwd), this.agentDir, { projectTrusted: true });
  }

  protected classifySkillSource(
    filePath: string,
    scope: "user" | "project" | "temporary",
    origin: "package" | "top-level",
    source: string,
  ): SkillSource {
    if (origin === "package" || this.skillPaths.some((path) => filePath === path || filePath.startsWith(`${path}${sep}`))) {
      return "bundled";
    }
    if (source === "auto" && filePath.split(sep).includes(".agents")) return "agents";
    if (scope === "project") return "project";
    return "user";
  }

  protected plainSkillPathEntries(paths: string[]): string[] {
    return paths.filter((entry) => !entry.startsWith("+") && !entry.startsWith("-") && !entry.startsWith("!"));
  }

  protected expandSkillPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) throw new Error("技能路径不能为空。");
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(trimmed);
  }

  async getSkillConfiguration(cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const packageManager = new DefaultPackageManager({
      cwd: resolvedCwd,
      agentDir: this.agentDir,
      settingsManager,
    });
    const resolved = await packageManager.resolve(async () => "skip");
    const diagnostics: SkillDiagnostic[] = [];
    const skills: SkillEntry[] = [];
    const seen = new Set<string>();
    const skillPaths = settingsManager.getSkillPaths();
    const projectSkillPaths = [...(settingsManager.getProjectSettings().skills ?? [])];

    for (const entry of resolved.skills) {
      const loaded = loadSkills({
        cwd: resolvedCwd,
        agentDir: this.agentDir,
        skillPaths: [entry.path],
        includeDefaults: false,
      });
      for (const diagnostic of loaded.diagnostics) {
        diagnostics.push({ type: diagnostic.type, message: diagnostic.message, path: diagnostic.path });
      }
      for (const skill of loaded.skills) {
        if (seen.has(skill.filePath)) continue;
        seen.add(skill.filePath);
        const scope = entry.metadata.scope === "project" ? "project" : "user";
        const configuredSkill: SkillEntry = {
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          source: this.classifySkillSource(skill.filePath, entry.metadata.scope, entry.metadata.origin, entry.metadata.source),
          enabled: entry.enabled,
          disableModelInvocation: skill.disableModelInvocation,
          scope,
        };
        if (!skillIsRemoved(configuredSkill, resolvedCwd, this.agentDir, skillPaths, projectSkillPaths)) skills.push(configuredSkill);
      }
    }

    if (this.skillPaths.length > 0) {
      const bundled = loadSkills({
        cwd: resolvedCwd,
        agentDir: this.agentDir,
        skillPaths: this.skillPaths,
        includeDefaults: false,
      });
      for (const diagnostic of bundled.diagnostics) {
        diagnostics.push({ type: diagnostic.type, message: diagnostic.message, path: diagnostic.path });
      }
      for (const skill of bundled.skills) {
        if (seen.has(skill.filePath)) continue;
        seen.add(skill.filePath);
        skills.push({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          source: "bundled",
          enabled: true,
          disableModelInvocation: skill.disableModelInvocation,
          scope: "user",
        });
      }
    }

    skills.sort((left, right) => left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath));
    return {
      agentDir: this.agentDir,
      userSkillsDir: join(this.agentDir, "skills"),
      projectSkillsDir: join(resolvedCwd, ".pi", "skills"),
      agentsSkillsDir: join(homedir(), ".agents", "skills"),
      skillPaths,
      projectSkillPaths,
      customSkillPaths: this.plainSkillPathEntries(skillPaths).map((path) => this.expandSkillPath(path)),
      enableSkillCommands: settingsManager.getEnableSkillCommands(),
      skills,
      diagnostics,
    };
  }

  async setSkillEnabled(filePath: string, enabled: boolean, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const snapshot = await this.getSkillConfiguration(resolvedCwd);
    const skill = snapshot.skills.find((entry) => entry.filePath === filePath);
    if (!skill) throw new Error(`未找到技能：${filePath}`);
    if (skill.source === "bundled") throw new Error("内置技能不能在此开关。");

    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const pattern = skillOverridePattern(skill.filePath, skillPatternBaseDir(skill, resolvedCwd, this.agentDir));

    if (skill.scope === "project") {
      const current = [...(settingsManager.getProjectSettings().skills ?? [])];
      settingsManager.setProjectSkillPaths(rewriteSkillOverridePaths(current, pattern, enabled));
    } else {
      settingsManager.setSkillPaths(rewriteSkillOverridePaths(settingsManager.getSkillPaths(), pattern, enabled));
    }
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const next = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, next);
    return next;
  }

  async removeSkill(filePath: string, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const snapshot = await this.getSkillConfiguration(resolvedCwd);
    const skill = snapshot.skills.find((entry) => entry.filePath === filePath);
    if (!skill) throw new Error(`未找到技能：${filePath}`);
    if (skill.source === "bundled") throw new Error("内置技能不能从 SuoCode 移除。");

    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const pattern = skillOverridePattern(skill.filePath, skillPatternBaseDir(skill, resolvedCwd, this.agentDir));
    if (skill.scope === "project") {
      const current = [...(settingsManager.getProjectSettings().skills ?? [])];
      settingsManager.setProjectSkillPaths(removeSkillOverride(current, pattern));
    } else {
      settingsManager.setSkillPaths(removeSkillOverride(settingsManager.getSkillPaths(), pattern));
    }
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const next = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, next);
    return next;
  }

  async deleteSkill(filePath: string, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const snapshot = await this.getSkillConfiguration(resolvedCwd);
    const skill = snapshot.skills.find((entry) => entry.filePath === filePath);
    if (!skill) {
      if (!deleteInvalidManagedSkill(snapshot, filePath)) throw new Error(`未找到技能：${filePath}`);
      this.reloadActiveSessionResources("Skills 重新加载失败");
      const next = await this.getSkillConfiguration(resolvedCwd);
      this.updateActiveSkillConfiguration(resolvedCwd, next);
      return next;
    }
    if (skill.source === "bundled") throw new Error("内置技能不能删除。");
    if (skill.source !== "user" || skill.scope !== "user") {
      throw new Error("只能删除 SuoCode 自维护目录中的技能。");
    }

    const managedRoot = safeRealPath(join(this.agentDir, "skills"));
    const skillRoot = safeRealPath(skill.baseDir);
    const relativeSkillRoot = relative(managedRoot, skillRoot);
    if (!relativeSkillRoot || relativeSkillRoot === ".." || relativeSkillRoot.startsWith(`..${sep}`) || isAbsolute(relativeSkillRoot)) {
      throw new Error("只能删除 SuoCode 自维护目录中的技能。");
    }

    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const pattern = skillOverridePattern(skill.filePath, this.agentDir);
    const currentPaths = settingsManager.getSkillPaths();
    const nextPaths = currentPaths.filter((entry) => {
      const stripped = entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
      return stripped !== pattern;
    });
    if (nextPaths.length !== currentPaths.length) settingsManager.setSkillPaths(nextPaths);

    rmSync(skillRoot, { recursive: true, force: false });
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const next = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, next);
    return next;
  }

  async addSkillPath(path: string, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const resolvedPath = this.expandSkillPath(path);
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      throw new Error(`技能目录不存在：${resolvedPath}`);
    }
    validateSkillImport(resolvedPath, resolvedCwd, this.agentDir);
    const managedRoot = join(this.agentDir, "skills");
    const sourceRealPath = safeRealPath(resolvedPath);
    if (sourceRealPath === safeRealPath(managedRoot) || sourceRealPath.startsWith(`${safeRealPath(managedRoot)}${sep}`)) {
      throw new Error("所选目录已经位于 SuoCode 自维护技能目录中。");
    }
    mkdirSync(managedRoot, { recursive: true });
    const baseName = basename(resolvedPath).trim() || "imported-skill";
    let destination = join(managedRoot, baseName);
    let suffix = 2;
    while (safeRealPath(destination) === sourceRealPath || existsSync(destination)) {
      destination = join(managedRoot, `${baseName}-${suffix}`);
      suffix += 1;
    }
    cpSync(resolvedPath, destination, { recursive: true, force: false, errorOnExist: true });
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const next = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, next);
    return next;
  }

  async removeSkillPath(path: string, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const resolvedPath = this.expandSkillPath(path);
    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const next = settingsManager.getSkillPaths().filter((entry) => {
      if (entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!")) return true;
      try {
        return this.expandSkillPath(entry) !== resolvedPath;
      } catch {
        return entry !== path;
      }
    });
    settingsManager.setSkillPaths(next);
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const snapshot = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, snapshot);
    return snapshot;
  }

  async setEnableSkillCommands(enabled: boolean, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const settingsManager = this.skillSettingsManager(resolvedCwd);
    settingsManager.setEnableSkillCommands(enabled);
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const snapshot = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, snapshot);
    return snapshot;
  }

  protected updateActiveSkillConfiguration(cwd: string, snapshot: SkillConfigurationSnapshot): void {
    const active = this.active;
    if (!active || safeRealPath(active.cwd) !== safeRealPath(cwd)) return;
    active.skillConfiguration = snapshot;
    this.publishRuntimeInspection(active);
  }
}
