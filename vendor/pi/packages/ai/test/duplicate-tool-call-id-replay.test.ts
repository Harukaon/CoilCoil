import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	OpenAICompletionsCompat,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} as unknown as Parameters<typeof convertMessages>[2];

function completionsModel(): Model<"openai-completions"> {
	return {
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "relay",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: compat as OpenAICompletionsCompat,
	};
}

function anthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function assistantTurn(calls: ToolCall[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls,
		api: "openai-completions",
		provider: "relay",
		model: "deepseek-v4-flash",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolCall(id: string, name: string): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function toolResult(call: ToolCall, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

/**
 * Three turns of a provider that numbers its tool calls per response, so every
 * turn hands out `call_0` and `call_1` again.
 */
function repeatedIdHistory(): Message[] {
	const messages: Message[] = [{ role: "user", content: "start", timestamp: Date.now() }];
	for (let turn = 1; turn <= 3; turn++) {
		const first = toolCall("call_0", "bash");
		const second = toolCall("call_1", "bash");
		messages.push(assistantTurn([first, second]));
		messages.push(toolResult(first, `turn ${turn} first`));
		messages.push(toolResult(second, `turn ${turn} second`));
	}
	return messages;
}

describe("tool call ids repeated across turns", () => {
	it("gives every replayed openai-completions call its own id and result", () => {
		const context: Context = { messages: repeatedIdHistory() };
		const params = convertMessages(completionsModel(), context, compat);

		const callIds: string[] = [];
		const results: { id: string; content: string }[] = [];
		for (const param of params) {
			if (param.role === "assistant" && Array.isArray(param.tool_calls)) {
				for (const call of param.tool_calls) callIds.push(call.id);
			}
			if (param.role === "tool") {
				results.push({ id: param.tool_call_id, content: String(param.content) });
			}
		}

		expect(new Set(callIds).size).toBe(callIds.length);
		expect(results.map((result) => result.id)).toEqual(callIds);
		expect(results.map((result) => result.content)).toEqual([
			"turn 1 first",
			"turn 1 second",
			"turn 2 first",
			"turn 2 second",
			"turn 3 first",
			"turn 3 second",
		]);
	});

	it("keeps ids unique when the same history is replayed to an Anthropic model", () => {
		const transformed = transformMessages(repeatedIdHistory(), anthropicModel(), (id) =>
			id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
		);

		const callIds: string[] = [];
		const resultIds: string[] = [];
		for (const msg of transformed) {
			if (msg.role === "assistant") {
				for (const block of msg.content) {
					if (block.type === "toolCall") callIds.push(block.id);
				}
			}
			if (msg.role === "toolResult") resultIds.push(msg.toolCallId);
		}

		expect(callIds).toEqual(["call_0", "call_1", "call_0_2", "call_1_2", "call_0_3", "call_1_3"]);
		expect(resultIds).toEqual(callIds);
	});

	it("leaves already-unique ids alone", () => {
		const first = toolCall("call_abc", "read");
		const second = toolCall("call_def", "bash");
		const messages: Message[] = [
			{ role: "user", content: "go", timestamp: Date.now() },
			assistantTurn([first]),
			toolResult(first, "a"),
			assistantTurn([second]),
			toolResult(second, "b"),
		];

		const transformed = transformMessages(messages, anthropicModel(), (id) => id);
		const ids = transformed.flatMap((msg) =>
			msg.role === "assistant" ? msg.content.filter((block) => block.type === "toolCall").map((block) => block.id) : [],
		);

		expect(ids).toEqual(["call_abc", "call_def"]);
	});
});
