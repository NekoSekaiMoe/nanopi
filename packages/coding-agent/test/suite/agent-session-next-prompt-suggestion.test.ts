import { fauxAssistantMessage } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession next-prompt suggestions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("returns undefined before any assistant reply", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(await harness.session.generateNextPromptSuggestion()).toBeUndefined();
	});

	it("returns a sanitized single-line suggestion after a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("all done"), fauxAssistantMessage('  "Run the tests\nand more"  ')]);
		await harness.session.prompt("hi");

		const suggestion = await harness.session.generateNextPromptSuggestion();

		expect(suggestion).toBe("Run the tests and more");
		// The suggestion request is a side-channel completion: it must not
		// touch the transcript or leave scripted responses behind.
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("returns undefined for an empty suggestion", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("")]);
		await harness.session.prompt("hi");

		expect(await harness.session.generateNextPromptSuggestion()).toBeUndefined();
	});

	it("returns undefined when aborted before the request", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("hi");

		const controller = new AbortController();
		controller.abort();
		expect(await harness.session.generateNextPromptSuggestion({ signal: controller.signal })).toBeUndefined();
	});
});
