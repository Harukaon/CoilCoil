import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/** The shape Pi's settings manager hands to compaction. */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

const INSTALLED = Symbol.for("coilcoil.compaction-settings.installed");

/**
 * A compaction has to summarize at least as much as it keeps, or the cut point
 * walks past the whole history and the summary buys nothing.
 */
const KEEP_RECENT_CEILING_RATIO = 0.5;

/**
 * Keep Pi's compaction budget from silently disabling itself.
 *
 * Pi expresses the budget as two absolute token counts: `reserveTokens` (16384)
 * decides when compaction fires, `keepRecentTokens` (20000) decides how much
 * conversation survives it verbatim. Twenty thousand is a sensible amount to
 * keep and is left exactly as it is — this only ever lowers it, never raises it.
 *
 * It has to be lowered in one case. Once `keepRecentTokens` exceeds
 * `contextWindow - reserveTokens`, the cut point walks past the entire history,
 * `prepareCompaction` finds nothing to summarize and returns undefined, and
 * compaction quietly does nothing at all — every turn, until the request
 * overflows, at which point overflow recovery takes the same path and also does
 * nothing. A 32k model is already inside that dead zone with Pi's defaults, and
 * CoilCoil lets users set `contextWindow` per model in settings, so anyone on a
 * local model is one number away from it.
 *
 * An explicitly configured `keepRecentTokens` is left alone even then: that is a
 * deliberate choice, and silently overriding it would be its own surprise.
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
    Math.min(settings.keepRecentTokens, Math.floor(summarizable * KEEP_RECENT_CEILING_RATIO)),
  );
  return keepRecentTokens === settings.keepRecentTokens ? settings : { ...settings, keepRecentTokens };
}

/**
 * Wrap `getCompactionSettings` on a settings manager so every caller inside Pi
 * sees the clamped budget. Wrapping the one accessor is the same trick
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
