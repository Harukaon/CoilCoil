import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The shape of a model, narrowed to what an override touches. */
type OverridableModel = { provider: string; id: string; contextWindow: number };

const INSTALLED = Symbol.for("coilcoil.model-overrides.installed");

/**
 * Make CoilCoil's per-model overrides authoritative wherever Pi resolves a model.
 *
 * `contextWindow` overrides live in CoilCoil's own `model-runtime-options.json`,
 * which Pi's registry knows nothing about. Applying them to the model object
 * after Pi handed it over meant re-applying them at every point Pi rebuilds one
 * — and Pi rebuilds one legitimately, whenever a provider registers or
 * unregisters, because the registry is its source of truth. The
 * `openai-responses-ws` extension refreshes its catalogue in the background a
 * few seconds into every session and re-registers, which silently reverted the
 * override and left compaction measuring against the model's catalogue window
 * instead of the user's: a session ran to 347k tokens under a 230k setting
 * because the threshold in force was the catalogue's 1.05M.
 *
 * Wrapping `getModel` fixes it at the one point all of those paths go through,
 * including Pi's own `refreshModelFromRegistry`, so no call site can be missed
 * again.
 *
 * Deliberately not memoized. Pi's registry already returns a fresh model object
 * per lookup, so there is no identity to preserve and a cache of our own could
 * only go stale against a catalogue that had since been re-registered — which
 * is the very thing these refreshes exist to deliver.
 */
export function installModelOverrides(
  runtime: ModelRuntime,
  overrideFor: (provider: string, id: string) => { contextWindow?: number } | undefined,
): ModelRuntime {
  const marked = runtime as ModelRuntime & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return runtime;
  // A registry that resolves no models has nothing to override — a stub built
  // for the auth paths, for one. Installing over it would only turn a partial
  // double into a crash.
  if (typeof runtime.getModel !== "function") return runtime;
  marked[INSTALLED] = true;

  const original = runtime.getModel.bind(runtime);
  runtime.getModel = ((provider: string, id: string) => {
    const model = original(provider, id);
    if (!model) return model;
    const contextWindow = overrideFor(provider, id)?.contextWindow;
    const target = model as unknown as OverridableModel;
    if (!contextWindow || contextWindow === target.contextWindow) return model;
    return { ...target, contextWindow } as unknown as typeof model;
  }) as ModelRuntime["getModel"];

  return runtime;
}
