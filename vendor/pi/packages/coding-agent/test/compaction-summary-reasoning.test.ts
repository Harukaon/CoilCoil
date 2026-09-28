import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Model, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	completeSummarization,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(
	reasoning: boolean,
	maxTokens = 8192,
	compat?: Model<"anthropic-messages">["compat"],
): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
		...(compat ? { compat } : {}),
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const mockToolCallResponse: AssistantMessage = {
	...mockSummaryResponse,
	content: [{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } }],
	stopReason: "toolUse",
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).resolves.toBe(
			"## Goal\nTest summary",
		);
	});

	it("uses fresh routing sessions without prompt caching", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);

		const sessionIds = requestOptions.map((options) => options?.sessionId);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("honors caller-supplied routing session and tool choice without prompt caching", async () => {
		await completeSummarization(createModel(false), normalizeContext({ systemPrompt: "Summarize", messages: [] }), {
			sessionId: "current-routing-session",
			cacheRetention: "long",
			toolChoice: "auto",
		});

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			sessionId: "current-routing-session",
			cacheRetention: "none",
			toolChoice: "auto",
		});
	});

	it("preserves the previous summary without an empty history request for a split turn", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			previousSummary: "previous checkpoint",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(result.summary).toContain("previous checkpoint");
		const requestContext = completeSimpleMock.mock.calls[0][1] as TranscriptContext;
		const prompt = JSON.stringify(requestContext.messages);
		// Regression test for #9652: clear boundaries and continuation wording avoid the reasoning-extraction false positive.
		expect(prompt).toContain("# Conversation\\n[User]: Summarize this.");
		expect(prompt).toContain("# Instructions\\nThe messages above are earlier context from an ongoing conversation.");
	});

	it("rejects tool calls from conversation summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);

		await expect(generateSummaryWithUsage(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"Summarization attempted to call a tool",
		);
	});

	it("rejects tool calls from split-turn summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"Turn prefix summarization attempted to call a tool",
		);
	});

	it("rejects a length-limited history summary", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});

		await expect(generateSummaryWithUsage(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([1600, 2000]);
	});

	it("retries an incomplete history checkpoint with the full reserve", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				stopReason: "length",
				content: [{ type: "text", text: "partial" }],
			})
			.mockResolvedValueOnce(mockSummaryResponse);

		const result = await generateSummaryWithUsage(messages, createModel(false, 384000), 16384, "test-key");

		expect(result.text).toBe("## Goal\nTest summary");
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([13107, 16384]);
		expect(result.usage.output).toBe(mockSummaryResponse.usage.output * 2);
	});

	it("keeps thinking and long tool arguments out of the summary request", async () => {
		const conversation: AgentMessage[] = [
			{ role: "user", content: "请修复压缩失败", timestamp: Date.now() },
			{
				...mockSummaryResponse,
				content: [
					{ type: "thinking", thinking: "hidden reasoning ".repeat(100_000) },
					{ type: "text", text: "已找到问题：摘要输入过长。" },
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "session.jsonl", payload: "argument noise ".repeat(10_000) },
					},
				],
			},
		];

		await generateSummaryWithUsage(conversation, createModel(false), 2000, "test-key");

		const prompt = JSON.stringify((completeSimpleMock.mock.calls[0][1] as TranscriptContext).messages);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(prompt).toContain("请修复压缩失败");
		expect(prompt).toContain("已找到问题");
		expect(prompt).not.toContain("hidden reasoning");
		expect(prompt.length).toBeLessThan(10_000);
	});

	it("splits a long Chinese conversation into bounded summary requests", async () => {
		const conversation: AgentMessage[] = [
			{
				role: "user",
				content: `第一部分：${"中文项目需求。".repeat(20_000)}最后部分：保留当前决定。`,
				timestamp: Date.now(),
			},
		];

		const result = await generateSummaryWithUsage(conversation, createModel(false), 2000, "test-key");
		const prompts = completeSimpleMock.mock.calls.map((call) =>
			JSON.stringify((call[1] as TranscriptContext).messages),
		);

		expect(result.text).toContain("Test summary");
		expect(prompts.length).toBeGreaterThan(1);
		expect(prompts[0]).toContain("第一部分");
		expect(prompts.at(-1)).toContain("最后部分");
		expect(prompts.every((prompt) => prompt.length < 110_000)).toBe(true);
	});

	it("halves a request when the provider reports input context overflow", async () => {
		completeSimpleMock.mockImplementation((_model, context: TranscriptContext) => {
			const prompt = JSON.stringify(context.messages);
			return prompt.length > 15_000
				? {
						...mockSummaryResponse,
						stopReason: "error",
						errorMessage: "The input is longer than the model's context length",
					}
				: mockSummaryResponse;
		});
		const conversation: AgentMessage[] = [
			{ role: "user", content: "请保留需求。".repeat(4000), timestamp: Date.now() },
		];

		const result = await generateSummaryWithUsage(conversation, createModel(false), 2000, "test-key");

		expect(result.text).toContain("Test summary");
		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(2);
		expect(
			completeSimpleMock.mock.calls.some(
				(call) => JSON.stringify((call[1] as TranscriptContext).messages).length < 15_000,
			),
		).toBe(true);
	});

	it("halves a request when the provider throws an input context error", async () => {
		completeSimpleMock.mockImplementation((_model, context: TranscriptContext) => {
			if (JSON.stringify(context.messages).length > 15_000) {
				throw new Error("400 invalid_request_error: The input is longer than the model's context length");
			}
			return mockSummaryResponse;
		});

		const result = await generateSummaryWithUsage(
			[{ role: "user", content: "保留任务进度。".repeat(4000), timestamp: Date.now() }],
			createModel(false),
			2000,
			"test-key",
		);

		expect(result.text).toContain("Test summary");
		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(2);
	});

	it("uses a bounded mechanical checkpoint if even a minimal request overflows", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			stopReason: "error",
			errorMessage: "Context overflow recovery failed: input is longer than the model's context length",
		});
		const conversation: AgentMessage[] = [
			{ role: "user", content: "最新中文要求：继续修复压缩。", timestamp: Date.now() },
		];

		const result = await generateSummaryWithUsage(conversation, createModel(false), 2000, "test-key");

		expect(result.text).toContain("最新中文要求：继续修复压缩。");
		expect(result.text).toContain("mechanical checkpoint");
		expect(result.text.length).toBeLessThan(16_000);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("bounds a split-turn prefix without changing its persisted messages", async () => {
		const longRequest = "继续处理当前中文任务。".repeat(20_000);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: [{ role: "user", content: longRequest, timestamp: Date.now() }],
			isSplitTurn: true,
			tokensBefore: 200_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		const result = await compact(preparation, createModel(false), "test-key");
		const prompts = completeSimpleMock.mock.calls.map((call) =>
			JSON.stringify((call[1] as TranscriptContext).messages),
		);

		expect(result.summary).toContain("Turn Context (split turn)");
		expect(prompts.length).toBeGreaterThan(1);
		expect(prompts.every((prompt) => prompt.length < 110_000)).toBe(true);
		expect(preparation.turnPrefixMessages[0]).toMatchObject({ content: longRequest });
	});

	it("rejects a length-limited split-turn summary", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([1000, 2000]);
	});

	it("retries an incomplete split-turn checkpoint with the full reserve", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				stopReason: "length",
				content: [{ type: "text", text: "partial" }],
			})
			.mockResolvedValueOnce(mockSummaryResponse);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20 },
		};
		const result = await compact(preparation, createModel(false, 384000), "test-key");
		expect(result.summary).toContain("Test summary");
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([8192, 16384]);
		expect(result.usage?.output).toBe(mockSummaryResponse.usage.output * 2);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("leaves Anthropic refusal fallback handling to pi-ai model metadata", async () => {
		await generateSummary(
			messages,
			createModel(true, 8192, {
				allowedFallbackModels: [
					{
						provider: "anthropic",
						model: "claude-opus-4-8",
						cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
					},
				],
			}),
			2000,
			"test-key",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("refusalFallbacks");
	});

	it("does not set Anthropic refusal fallback for models without allowed fallback targets", async () => {
		await generateSummary(messages, createModel(true), 2000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("refusalFallbacks");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});
});
