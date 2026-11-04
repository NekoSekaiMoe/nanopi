import type { AgentMessage } from "@nanopi/pi-agent-core";
import { describe, expect, test } from "vitest";
import { estimateTokens, isCutPointMessage, isTurnStartMessage } from "../src/core/compaction/compaction.ts";
import type { MessageTypeCodec } from "../src/core/messages/codec.ts";
import { MessageTypeRegistry } from "../src/core/messages/registry.ts";
import { convertToLlm } from "../src/core/messages.ts";

/** A role invented outside core/messages.ts, the way a module would add one. */
interface BuildResultMessage {
	role: "buildResult";
	summary: string;
	hidden?: boolean;
	timestamp: number;
}

function buildResult(summary: string, hidden = false): AgentMessage {
	return { role: "buildResult", summary, hidden, timestamp: 1 } as unknown as AgentMessage;
}

function buildResultCodec(overrides: Partial<MessageTypeCodec> = {}): MessageTypeCodec {
	return {
		kind: "buildResult",
		toLlm: (message) => {
			const result = message as unknown as BuildResultMessage;
			return [{ role: "user", content: [{ type: "text", text: result.summary }], timestamp: result.timestamp }];
		},
		...overrides,
	};
}

describe("message codecs", () => {
	test("convertToLlm uses the codec of a role the host does not know", () => {
		const registry = new MessageTypeRegistry();
		registry.register(buildResultCodec());

		const converted = convertToLlm([buildResult("build ok")], registry.table());
		expect(converted).toHaveLength(1);
		expect(converted[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "build ok" }] });
	});

	test("a codec can keep a message out of the request", () => {
		const registry = new MessageTypeRegistry();
		const codec = buildResultCodec();
		registry.register({
			...codec,
			toLlm: (message) => ((message as unknown as BuildResultMessage).hidden ? [] : codec.toLlm(message)),
		});

		expect(convertToLlm([buildResult("visible"), buildResult("hidden", true)], registry.table())).toHaveLength(1);
	});

	// Regression: the core fallback used to be "anything but toolResult", which
	// made a system message a cut point and split a turn that never split.
	test("system is not a cut point", () => {
		const system = { role: "system", content: "prompt", timestamp: 1 } as unknown as AgentMessage;
		expect(isCutPointMessage(system)).toBe(false);
		expect(isTurnStartMessage(system)).toBe(false);
	});

	test("a role without a codec stays out of the request", () => {
		const registry = new MessageTypeRegistry();
		expect(convertToLlm([buildResult("orphan")], registry.table())).toEqual([]);
	});

	test("estimateTokens reads the session table", () => {
		const registry = new MessageTypeRegistry();
		const message = buildResult("x");
		expect(estimateTokens(message, registry.table())).toBe(0);

		registry.register(buildResultCodec({ estimateTokens: () => 42 }));
		expect(estimateTokens(message, registry.table())).toBe(42);
	});

	test("a codec can re-measure a core role", () => {
		const registry = new MessageTypeRegistry();
		const assistant = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1 } as AgentMessage;
		expect(estimateTokens(assistant, registry.table())).toBe(2);

		registry.register({ kind: "assistant", toLlm: () => [], estimateTokens: () => 99 });
		expect(estimateTokens(assistant, registry.table())).toBe(99);
	});

	test("registering the same kind again replaces the codec", () => {
		const registry = new MessageTypeRegistry();
		registry.register(buildResultCodec({ estimateTokens: () => 1 }));
		registry.register(buildResultCodec({ estimateTokens: () => 2 }));
		expect(estimateTokens(buildResult("x"), registry.table())).toBe(2);
	});

	test("built-in kinds cannot be dropped", () => {
		const registry = new MessageTypeRegistry();
		const custom = { role: "custom", content: "hello", display: true, timestamp: 1 } as unknown as AgentMessage;
		expect(estimateTokens(custom, registry.table())).toBe(2);
		expect(registry.unregister("custom")).toBe(false);
		expect(convertToLlm([custom], registry.table())).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		]);
	});

	test("a cut-point codec is what compaction reads", () => {
		const system = { role: "system", content: "prompt", timestamp: 1 } as unknown as AgentMessage;
		expect(isCutPointMessage(system)).toBe(false);
		expect(isTurnStartMessage(system)).toBe(false);

		const registry = new MessageTypeRegistry();
		registry.register({ kind: "system", toLlm: () => [], estimateTokens: () => 1 });
		// Registering a kind does not move the cut search: the rule lives in compaction.
		expect(isCutPointMessage(system)).toBe(false);
		expect(registry.codecForKind("system")).toBeDefined();
	});
});
