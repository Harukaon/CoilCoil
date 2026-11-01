import type { Message, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

describe("abort before a provider request", () => {
	for (const stage of ["already", "prepareRequest", "transformContext", "getApiKey"] as const) {
		it(`does not call the provider when aborted during ${stage}`, async () => {
			const controller = new AbortController();
			const events: AgentEvent[] = [];
			const config: AgentLoopConfig = {
				model,
				convertToLlm: (messages) => messages as Message[],
			};
			if (stage === "already") controller.abort();
			if (stage === "prepareRequest")
				config.prepareRequest = async () => {
					controller.abort();
				};
			if (stage === "transformContext")
				config.transformContext = async (messages) => {
					controller.abort();
					return messages;
				};
			if (stage === "getApiKey")
				config.getApiKey = async () => {
					controller.abort();
					return "unused";
				};
			const provider = vi.fn(() => {
				throw new Error("aborted preflight reached the provider");
			});
			await runAgentLoop(
				[{ role: "user", content: "hello", timestamp: Date.now() }],
				{ messages: [], tools: [] },
				config,
				(event) => {
					events.push(event);
				},
				controller.signal,
				provider,
			);
			expect(provider).not.toHaveBeenCalled();
			expect(events.filter((event) => event.type === "message_end" && event.message.role === "assistant")).toEqual([
				expect.objectContaining({
					message: expect.objectContaining({
						stopReason: "aborted",
						usage: expect.objectContaining({ totalTokens: 0 }),
					}),
				}),
			]);
			expect(events.find((event) => event.type === "turn_end")).toMatchObject({
				message: { stopReason: "aborted" },
			});
			expect(events.at(-1)?.type).toBe("agent_end");
		});
	}
});
