import { describe, expect, it } from "vitest";
import { buildContext, transcriptExcerpt } from "../src/extras/pi-btw/src/index.ts";

function user(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
}
function assistant(text: string) {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: 2 };
}
function toolResult() {
	return { role: "toolResult" as const, content: [{ type: "text" as const, text: "huge payload" }], timestamp: 3 };
}

describe("transcriptExcerpt", () => {
	it("keeps user and assistant text and drops tool traffic", () => {
		const excerpt = transcriptExcerpt([
			user("why git refs"),
			assistant("because bash can mutate"),
			toolResult(),
		] as never);
		expect(excerpt).toContain("User: why git refs");
		expect(excerpt).toContain("Assistant: because bash can mutate");
		expect(excerpt).not.toContain("huge payload");
	});

	it("keeps the newest tail when the budget runs out", () => {
		const messages = [user("old"), assistant("older answer"), user("newest")] as never;
		const excerpt = transcriptExcerpt(messages, 10);
		expect(excerpt).toBe("User: newest");
	});

	it("clips one oversized message", () => {
		const excerpt = transcriptExcerpt([user("x".repeat(20_000))] as never);
		expect(excerpt).toContain("…(truncated)");
		expect(excerpt.length).toBeLessThan(7_000);
	});
});

describe("buildContext", () => {
	it("puts the session before the side thread", () => {
		const context = buildContext("User: hi", [{ question: "why", answer: "because" }]);
		expect(context.indexOf("## Session so far")).toBeLessThan(context.indexOf("## This side thread"));
		expect(context).toContain("### Question 1\nwhy");
	});

	it("omits an empty excerpt", () => {
		expect(buildContext("", [])).toBe("");
	});
});
