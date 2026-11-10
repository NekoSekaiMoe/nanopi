import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

const EMOJI = "\u{1F600}"; // two UTF-16 code units

function hasLoneSurrogate(text: string): boolean {
	return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

// #634: a tool result cut at exactly 2000 chars landed a lone surrogate in the
// summary request, which a strict JSON encoder rejects outright.
describe("serializeConversation truncation", () => {
	it("does not leave half an emoji when the cut falls inside a pair", () => {
		const content = `${"a".repeat(1999)}${EMOJI}rest`;
		const serialized = serializeConversation([
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: content }],
				isError: false,
				timestamp: 0,
			} as never,
		]);

		expect(hasLoneSurrogate(serialized)).toBe(false);
		// 1999 'a' plus half of the emoji is what a plain slice(0, 2000) would keep.
		expect(serialized).toContain(`${"a".repeat(1999)}\n\n[... 5 more characters truncated]`);
	});
});
