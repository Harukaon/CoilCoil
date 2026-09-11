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
 * How much conversation survives a compaction verbatim: Pi's own 20000.
 *
 * CoilCoil used to raise this to 50000, and that number is what made a real
 * session compact every twenty minutes. Pi counts this budget with chars/4,
 * which is about right for English and four times short for Chinese — one
 * character is one token. In a Chinese session "keep 50000" kept 126000 real
 * tokens; with 11000 of fixed prompt and a 20000-token summary on top, a
 * compaction left only 26000 free out of a 200000 window, so the next one was
 * minutes away.
 *
 * The lesson is not "20000 is the right number", it is that this budget is
 * denominated in a unit that lies. Until it is measured in real tokens, the
 * honest thing is to leave Pi's default alone rather than to multiply the lie.
 */
const KEEP_RECENT_TOKENS = 20_000;

/**
 * Keep Pi's compaction budget from silently disabling itself.
 *
 * Pi expresses the budget as two absolute token counts: `reserveTokens` (16384)
 * decides when compaction fires, `keepRecentTokens` (20000) decides how much
 * conversation survives it verbatim. Both are Pi's now — this function no longer
 * raises either one, it only clamps the survivor down in the one case where
 * leaving it alone breaks compaction outright.
 *
 * That case is not tuning, it is a failure to avoid. Once `keepRecentTokens`
 * exceeds `contextWindow - reserveTokens`, the cut point walks past the entire
 * history, `prepareCompaction` finds nothing to summarize and returns undefined,
 * and compaction quietly does nothing at all — every turn, until the request
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
    Math.min(
      settings.keepRecentTokens || KEEP_RECENT_TOKENS,
      Math.floor(summarizable * KEEP_RECENT_CEILING_RATIO),
    ),
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
