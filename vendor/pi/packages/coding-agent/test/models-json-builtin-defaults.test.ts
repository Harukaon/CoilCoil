import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicMessagesCompat, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getPromptCacheTtlMs, isReplayable } from "../src/core/cache-warmer.ts";
import { clearApiKeyCache, type ModelRegistry } from "../src/core/model-registry.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

// CoilCoil patch, see docs/pi-upstream.md ("models.json entries drop what the entry cannot say").
describe("models.json entry for a model the built-in provider already ships", () => {
	let tempDir: string;
	let modelsJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-builtin-defaults-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearApiKeyCache();
	});

	async function registryWith(providers: Record<string, unknown>): Promise<ModelRegistry> {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
		const registry = await createModelRegistry(AuthStorage.inMemory(), modelsJsonPath);
		expect(registry.getError()).toBeUndefined();
		return registry;
	}

	/** A built-in Claude model carrying what a catalogue entry cannot express: adaptive-thinking flags, a cache lifetime and image limits. */
	async function builtinClaude(): Promise<Model<"anthropic-messages">> {
		const bare = await createModelRegistry(AuthStorage.inMemory(), join(tempDir, "absent.json"));
		const found = bare
			.getAll()
			.find(
				(m) =>
					m.provider === "anthropic" &&
					m.api === "anthropic-messages" &&
					m.promptCache?.short !== undefined &&
					m.inputLimits !== undefined &&
					(m.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking === true,
			);
		expect(
			found,
			"the built-in catalog must ship an adaptive-thinking Claude model with a cache lifetime",
		).toBeDefined();
		return found as Model<"anthropic-messages">;
	}

	/** What a settings page writes for a listed model: catalogue facts only. */
	function catalogueEntry(id: string, extra: Record<string, unknown> = {}) {
		return {
			id,
			name: id,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200000,
			maxTokens: 64000,
			...extra,
		};
	}

	test("keeps the built-in prompt cache lifetime and compat that the entry leaves out", async () => {
		const builtin = await builtinClaude();
		const registry = await registryWith({ anthropic: { models: [catalogueEntry(builtin.id)] } });
		const listed = registry.find("anthropic", builtin.id);

		expect(listed?.promptCache).toEqual(builtin.promptCache);
		expect(listed?.compat).toEqual(builtin.compat);
		expect(listed?.inputLimits).toEqual(builtin.inputLimits);
		// Everything the entry does state is still its own.
		expect(listed?.contextWindow).toBe(200000);
		expect(listed?.cost.input).toBe(1);
	});

	test("a listed Claude model can still be kept warm and replayed", async () => {
		const builtin = await builtinClaude();
		const registry = await registryWith({ anthropic: { models: [catalogueEntry(builtin.id)] } });
		const listed = registry.find("anthropic", builtin.id) as Model<"anthropic-messages">;
		const options = { reasoning: "high", cacheRetention: "short" } as const;

		// Without these two answers the cache warmer stops with "cache lifetime unavailable" or
		// "request cannot be replayed safely", and nothing says so to the user.
		expect(getPromptCacheTtlMs(listed, options)).toBe((builtin.promptCache?.short ?? 0) * 1000);
		expect(isReplayable(listed, options)).toBe(true);
	});

	test("what the entry states itself wins, key by key", async () => {
		const builtin = await builtinClaude();
		const registry = await registryWith({
			anthropic: {
				models: [
					catalogueEntry(builtin.id, {
						compat: { forceAdaptiveThinking: false },
						promptCache: { short: 60 },
						inputLimits: { maxRequestBytes: 1000 },
					}),
				],
			},
		});
		const listed = registry.find("anthropic", builtin.id);
		const compat = listed?.compat as AnthropicMessagesCompat | undefined;
		const builtinCompat = builtin.compat as AnthropicMessagesCompat | undefined;

		expect(compat?.forceAdaptiveThinking).toBe(false);
		// Keys the entry does not mention still come from the built-in model.
		expect({ ...compat, forceAdaptiveThinking: true }).toEqual({ ...builtinCompat, forceAdaptiveThinking: true });
		// An entry that states one cache tier or one image limit does not lose the others.
		expect(listed?.promptCache).toEqual({ ...builtin.promptCache, short: 60 });
		expect(listed?.inputLimits?.maxRequestBytes).toBe(1000);
		expect(listed?.inputLimits?.images).toEqual(builtin.inputLimits?.images);
	});

	test("a model the built-in provider does not ship inherits nothing", async () => {
		const registry = await registryWith({ anthropic: { models: [catalogueEntry("claude-not-in-the-catalog")] } });
		const listed = registry.find("anthropic", "claude-not-in-the-catalog");

		expect(listed).toBeDefined();
		expect(listed?.promptCache).toBeUndefined();
		expect(listed?.compat).toBeUndefined();
	});

	test("the same id on a different API inherits nothing", async () => {
		const builtin = await builtinClaude();
		const registry = await registryWith({
			anthropic: { models: [catalogueEntry(builtin.id, { api: "openai-completions" })] },
		});
		const listed = registry.find("anthropic", builtin.id);

		expect(listed?.api).toBe("openai-completions");
		expect(listed?.promptCache).toBeUndefined();
		expect(listed?.compat).toBeUndefined();
	});
});
