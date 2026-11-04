import type { AgentMessage } from "@nanopi/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compaction/compaction.ts";
import type { MessageTypeCodec } from "../src/core/messages/codec.ts";
import { MessageTypeRegistry } from "../src/core/messages/registry.ts";
import { convertToLlm } from "../src/core/messages.ts";

function notification(text: string): AgentMessage {
	return { role: "notification", text, timestamp: 0 } as unknown as AgentMessage;
}

describe("message type registry", () => {
	it("projects a registered kind instead of dropping it", () => {
		const registry = new MessageTypeRegistry();
		expect(convertToLlm([notification("dropped")], registry.table())).toEqual([]);

		registry.register({
			kind: "notification",
			toLlm: (message) => [
				{ role: "user", content: [{ type: "text", text: (message as { text: string }).text }], timestamp: 0 },
			],
		});

		expect(convertToLlm([notification("kept")], registry.table())).toEqual([
			{ role: "user", content: [{ type: "text", text: "kept" }], timestamp: 0 },
		]);
	});

	it("sizes a registered kind through its own estimate", () => {
		const registry = new MessageTypeRegistry();
		const message = notification("x".repeat(40));
		expect(estimateTokens(message, registry.table())).toBe(0);

		registry.register({
			kind: "notification",
			toLlm: () => [],
			estimateTokens: (m) => (m as { text: string }).text.length,
		});
		expect(estimateTokens(message, registry.table())).toBe(40);
	});

	it("keeps built-in kinds when a module registers its own", () => {
		const registry = new MessageTypeRegistry();
		registry.register({ kind: "notification", toLlm: () => [] });
		expect(registry.codecForKind("bashExecution")).toBeDefined();
		expect(registry.unregister("bashExecution")).toBe(false);
	});

	it("narrows a single custom type without touching the others", () => {
		const registry = new MessageTypeRegistry();
		const specific: MessageTypeCodec = {
			kind: "custom",
			toLlm: () => [{ role: "user", content: "narrowed", timestamp: 0 }],
		};
		registry.register(specific, "exploring");

		const table = registry.table();
		const narrowed = { role: "custom", customType: "exploring", content: "x", timestamp: 0 } as AgentMessage;
		const other = { role: "custom", customType: "other", content: "y", timestamp: 0 } as AgentMessage;

		expect(convertToLlm([narrowed], table)[0]).toMatchObject({ content: "narrowed" });
		expect(convertToLlm([other], table)[0]).toMatchObject({ content: [{ type: "text", text: "y" }] });
	});

	it("forgets a custom type once its registration is gone", () => {
		const registry = new MessageTypeRegistry();
		const codec: MessageTypeCodec = { kind: "custom", toLlm: () => [] };
		registry.register(codec, "exploring");
		expect(registry.customTypes.get("exploring")).toBe(codec);

		registry.customTypes.delete("exploring");
		const message = { role: "custom", customType: "exploring", content: "z", timestamp: 0 } as AgentMessage;
		expect(convertToLlm([message], registry.table())[0]).toMatchObject({ content: [{ type: "text", text: "z" }] });
	});
});
