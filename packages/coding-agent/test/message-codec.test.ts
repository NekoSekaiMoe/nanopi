import type { AgentMessage } from "@nanopi/pi-agent-core";
import { afterEach, describe, expect, test } from "vitest";
import { estimateTokens, isCutPointMessage, isTurnStartMessage } from "../src/core/compaction/compaction.ts";
import { convertToLlm, registerMessageCodec, unregisterMessageCodec } from "../src/core/messages.ts";

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

afterEach(() => {
	unregisterMessageCodec("buildResult");
	unregisterMessageCodec("custom");
});

describe("message codecs", () => {
	test("convertToLlm uses the codec of a role the host does not know", () => {
		registerMessageCodec({
			role: "buildResult",
			toLlm: (message) => {
				const result = message as unknown as BuildResultMessage;
				return { role: "user", content: [{ type: "text", text: result.summary }], timestamp: result.timestamp };
			},
		});

		const converted = convertToLlm([buildResult("build ok")]);
		expect(converted).toHaveLength(1);
		expect(converted[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "build ok" }] });
	});

	test("a codec can keep a message out of the request", () => {
		registerMessageCodec({
			role: "buildResult",
			include: (message) => !(message as unknown as BuildResultMessage).hidden,
			toLlm: () => ({ role: "user", content: [], timestamp: 1 }),
		});

		expect(convertToLlm([buildResult("visible"), buildResult("hidden", true)])).toHaveLength(1);
	});

	// Regression: the core fallback used to be "anything but toolResult", which
	// made a system message a cut point and split a turn that never split.
	test("system is not a cut point", () => {
		const system = { role: "system", content: "prompt", timestamp: 1 } as unknown as AgentMessage;
		expect(isCutPointMessage(system)).toBe(false);
		expect(isTurnStartMessage(system)).toBe(false);
	});

	test("a role without a codec passes through unchanged", () => {
		const unknown = buildResult("orphan");
		expect(convertToLlm([unknown])).toEqual([unknown]);
	});

	test("estimateTokens and cut points read the codec", () => {
		registerMessageCodec({
			role: "buildResult",
			estimateTokens: () => 42,
			isCutPoint: () => false,
			isTurnStart: () => true,
		});

		const message = buildResult("x");
		expect(estimateTokens(message)).toBe(42);
		expect(isCutPointMessage(message)).toBe(false);
		expect(isTurnStartMessage(message)).toBe(true);
	});

	test("registering the same role again replaces the codec", () => {
		registerMessageCodec({ role: "buildResult", estimateTokens: () => 1 });
		registerMessageCodec({ role: "buildResult", estimateTokens: () => 2 });
		expect(estimateTokens(buildResult("x"))).toBe(2);
	});

	test("built-in codecs can be replaced and restored", () => {
		const custom = { role: "custom", content: "hello", display: true, timestamp: 1 } as unknown as AgentMessage;
		expect(estimateTokens(custom)).toBe(2);

		registerMessageCodec({ role: "custom", estimateTokens: () => 99 });
		expect(estimateTokens(custom)).toBe(99);

		unregisterMessageCodec("custom");
		expect(convertToLlm([custom])).toEqual([custom]);
	});
});
