import {
  type SubagentConfiguration,
  type SubagentConfigurationInput,
  type SubagentProfilesSnapshot,
} from "@coilcoil/runtime-protocol";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
} from "node:path";
import { RuntimeResourcesController } from "./runtime-resources.js";
import {
  LEGACY_SINGLE_MODEL_PROFILES,
  cleanSubagentModels,
  isSubagentModelKey,
  listSubagentProfiles as listProfilesFromDisk,
} from "./subagent-profiles.js";
import { isRecord } from "./runtime-utils.js";

/**
 * The subagent settings the runtime owns: which model each profile uses, and the list of
 * profiles the settings page shows.
 */
export abstract class RuntimeSubagents extends RuntimeResourcesController {
  private subagentSettingsPath(): string {
    return join(this.agentDir, "subagent-settings.json");
  }

  private normalizeSubagentConfiguration(value: unknown): SubagentConfiguration {
    const record = isRecord(value) ? value : {};
    const stored = isRecord(record.models) ? record.models : {};
    const models = cleanSubagentModels(stored);
    // The short-lived single-model format meant "this model for every profile". It still
    // covers the profiles that existed then; one the file spells out, even an empty one
    // that clears it, wins over it.
    const legacyModel = typeof record.model === "string" ? record.model.trim().slice(0, 200) : "";
    if (legacyModel) {
      for (const name of LEGACY_SINGLE_MODEL_PROFILES) {
        if (!Object.hasOwn(stored, name)) models[name] = legacyModel;
      }
    }
    return { models };
  }

  protected readSubagentConfiguration(): SubagentConfiguration {
    const path = this.subagentSettingsPath();
    if (!existsSync(path)) return this.normalizeSubagentConfiguration(undefined);
    try {
      return this.normalizeSubagentConfiguration(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return this.normalizeSubagentConfiguration(undefined);
    }
  }

  async getSubagentConfiguration(): Promise<SubagentConfiguration> {
    return this.readSubagentConfiguration();
  }

  /** Every subagent profile the open project can use, for the settings page. */
  async listSubagentProfiles(cwd?: string): Promise<SubagentProfilesSnapshot> {
    return listProfilesFromDisk({ workflowDir: this.workflowDir, agentDir: this.agentDir, cwd });
  }

  async saveSubagentConfiguration(input: SubagentConfigurationInput): Promise<SubagentConfiguration> {
    const incoming = isRecord(input) && isRecord(input.models) ? input.models : undefined;
    if (!incoming || Object.values(incoming).some((model) => typeof model !== "string")) {
      throw new Error("子代理配置无效。");
    }
    // Only the profiles the caller names change. A panel knows the profiles of the project
    // it is open on, not those of the others, so replacing the whole map would wipe them.
    const models = { ...this.readSubagentConfiguration().models };
    for (const [name, model] of Object.entries(incoming)) {
      if (!isSubagentModelKey(name)) continue;
      const chosen = String(model).trim().slice(0, 200);
      if (chosen) models[name] = chosen;
      else delete models[name];
    }
    const configuration: SubagentConfiguration = { models };
    const path = this.subagentSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    return configuration;
  }
}
