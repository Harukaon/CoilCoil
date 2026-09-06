import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/** The shape Pi's settings manager hands to compaction. */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

const INSTALLED = Symbol.for("coilcoil.compaction-settings.installed");

/** Share of the context window kept verbatim on the far side of a compaction. */
const KEEP_RECENT_RATIO = 0.25;

/**
 * A compaction has to summarize at least as much as it keeps, or the summary
 * costs a model call and buys nothing.
 */
const KEEP_RECENT_CEILING_RATIO = 0.5;

/**
 * Scale Pi's compaction budget to the context window actually in force.
 *
 * Pi expresses the budget as two absolute token counts — `reserveTokens`
 * (16384) decides when compaction fires, `keepRecentTokens` (20000) decides how
 * much conversation survives it verbatim — and neither one looks at the model.
 * Both ends of the model range suffer for it:
 *
 * - On a large window the survivor is a fixed 20k. A session that compacts at
 *   184k of a 200k window keeps roughly a tenth of what it had and replaces the
 *   rest with one prose summary. That cliff is the compaction complaint users
 *   actually feel.
 * - On a small window the two constants cross over: once `keepRecentTokens`
 *   exceeds `contextWindow - reserveTokens`, the cut point walks past the whole
 *   history, `prepareCompaction` finds nothing to summarize and returns
 *   undefined, and compaction silently does nothing at all — every turn, until
 *   the request overflows. CoilCoil lets users set `contextWindow` per model in
 *   settings, so this is one number away for anyone on a local model.
 *
 * Deriving the survivor from the window fixes both: a quarter of the window
 * stays verbatim, capped at half of what compaction can reach so there is
 * always a history worth summarizing. An explicitly configured
 * `keepRecentTokens` is left alone — that is a deliberate choice, not the
 * default nobody picked.
 */
export function compactionSettingsForWindow(
  settings: CompactionSettings,
  contextWindow: number | undefined,
): CompactionSettings {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return settings;
  const summarizable = contextWindow - settings.reserveTokens;
  if (summarizable <= 0) return settings;

  const keepRecentTokens = Math.max(
    1,
    Math.min(
      Math.max(settings.keepRecentTokens, Math.floor(contextWindow * KEEP_RECENT_RATIO)),
      Math.floor(summarizable * KEEP_RECENT_CEILING_RATIO),
    ),
  );
  return keepRecentTokens === settings.keepRecentTokens ? settings : { ...settings, keepRecentTokens };
}

/**
 * Wrap `getCompactionSettings` on a settings manager so every caller inside Pi
 * sees the window-aware budget. Wrapping the one accessor is the same trick
 * `installModelOverrides` uses on the model registry, and for the same reason:
 * Pi reads these settings from several places and a value applied afterwards
 * would have to be re-applied at each of them.
 */
export function installCompactionSettings(
  settingsManager: SettingsManager,
  contextWindowOf: () => number | undefined,
): SettingsManager {
  const marked = settingsManager as SettingsManager & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return settingsManager;
  if (typeof settingsManager.getCompactionSettings !== "function") return settingsManager;
  marked[INSTALLED] = true;

  const original = settingsManager.getCompactionSettings.bind(settingsManager);
  settingsManager.getCompactionSettings = (() => {
    const settings = original();
    if (userConfiguredKeepRecent(settingsManager)) return settings;
    return compactionSettingsForWindow(settings, contextWindowOf());
  }) as SettingsManager["getCompactionSettings"];

  return settingsManager;
}

function userConfiguredKeepRecent(settingsManager: SettingsManager): boolean {
  const scopes = [settingsManager.getProjectSettings?.(), settingsManager.getGlobalSettings?.()];
  return scopes.some((scope) => typeof scope?.compaction?.keepRecentTokens === "number");
}
