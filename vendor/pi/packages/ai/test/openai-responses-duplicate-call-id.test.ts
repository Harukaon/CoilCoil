import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Message, ToolResultMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface ReplayedCall {
	id: string;
	name: string;
}

function completionsTurn(calls: ReplayedCall[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(call: ReplayedCall, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function callPairs(input: ReturnType<typeof convertResponsesMessages>): {
	calls: string[];
	outputs: { callId: string; output: string }[];
} {
	const calls: string[] = [];
	const outputs: { callId: string; output: string }[] = [];
	for (const item of input) {
		if (item.type === "function_call") calls.push(item.call_id);
		if (item.type === "function_call_output") {
			outputs.push({ callId: item.call_id, output: typeof item.output === "string" ? item.output : "" });
		}
	}
	return { calls, outputs };
}

describe("OpenAI Responses duplicate call_id conversion", () => {
	it("renames call ids repeated across turns by openai-completions providers", () => {
		// DeepSeek and friends number their calls per response, so every assistant
		// turn hands out `call_0` again. Replaying that history verbatim makes the
		// Responses API reject the request with a duplicate call_id error.
		const model = getModel("openai", "gpt-5.5");
		const first: ReplayedCall = { id: "call_0", name: "read" };
		const second: ReplayedCall = { id: "call_0", name: "bash" };
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [
				{ role: "user", content: "read the file", timestamp: Date.now() },
				completionsTurn([first]),
				toolResult(first, "file contents"),
				{ role: "user", content: "now run it", timestamp: Date.now() },
				completionsTurn([second]),
				toolResult(second, "command output"),
			] satisfies Message[],
		};

		const { calls, outputs } = callPairs(convertResponsesMessages(model, context, new Set(["openai"])));

		expect(calls).toEqual(["call_0", "call_0_2"]);
		expect(new Set(calls).size).toBe(calls.length);
		expect(outputs).toEqual([
			{ callId: "call_0", output: "file contents" },
			{ callId: "call_0_2", output: "command output" },
		]);
	});

	it("keeps parallel calls that share one Responses call id paired with their own output", () => {
		// Responses histories can carry one call_id across several items. Those are
		// distinct calls, so each output has to follow its own item.
		const model = getModel("openai", "gpt-5.5");
		const first: ReplayedCall = { id: "call_abc|fc_1", name: "read" };
		const second: ReplayedCall = { id: "call_abc|fc_2", name: "read" };
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [
				{ role: "user", content: "read both files", timestamp: Date.now() },
				completionsTurn([first, second]),
				toolResult(first, "first file"),
				toolResult(second, "second file"),
			] satisfies Message[],
		};

		const { calls, outputs } = callPairs(convertResponsesMessages(model, context, new Set(["openai"])));

		expect(new Set(calls).size).toBe(calls.length);
		expect(outputs.map((entry) => entry.callId)).toEqual(calls);
		expect(outputs.map((entry) => entry.output)).toEqual(["first file", "second file"]);
	});

	it("leaves unique call ids untouched", () => {
		const model = getModel("openai", "gpt-5.5");
		const first: ReplayedCall = { id: "call_0", name: "read" };
		const second: ReplayedCall = { id: "call_1", name: "bash" };
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [
				{ role: "user", content: "do both", timestamp: Date.now() },
				completionsTurn([first, second]),
				toolResult(first, "a"),
				toolResult(second, "b"),
			] satisfies Message[],
		};

		const { calls, outputs } = callPairs(convertResponsesMessages(model, context, new Set(["openai"])));

		expect(calls).toEqual(["call_0", "call_1"]);
		expect(outputs).toEqual([
			{ callId: "call_0", output: "a" },
			{ callId: "call_1", output: "b" },
		]);
	});
});
