import { describe, expect, it } from "vitest";
import { defineTool, isToolCallEventType } from "../src/modules-api.ts";
import { getMarkdownTheme, renderDiff } from "../src/ui.ts";

describe("narrow entry points", () => {
	it("exports the module contracts as values, not only types", () => {
		expect(typeof defineTool).toBe("function");
		expect(typeof isToolCallEventType).toBe("function");
		// The type guards narrow the documented tool events without the root barrel.
		expect(isToolCallEventType("bash", { type: "tool_call", toolCallId: "1", toolName: "bash", input: {} })).toBe(
			true,
		);
	});

	it("exports the UI helpers a renderer needs", () => {
		expect(typeof getMarkdownTheme).toBe("function");
		expect(typeof renderDiff).toBe("function");
	});
});
